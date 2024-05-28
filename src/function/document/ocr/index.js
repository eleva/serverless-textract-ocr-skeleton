'use strict';
//require utils from lambda layer
const utils = require('utils');
// Get textract client and commands
const { TextractClient, AnalyzeIDCommand } = require("@aws-sdk/client-textract"); // CommonJS import
// Get S3 Client and commands
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
// Get DynamoDB Client
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { ExecuteStatementCommand, DynamoDBDocumentClient} = require("@aws-sdk/lib-dynamodb");

//init config for test environment
const config =
    process.env.APP_ENV==='test'?
        {
        region: process.env.AWS_REGION, // Change this to your desired AWS region
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
    }
    :{};

//set config in clients
const s3Client = new S3Client(config);
const textractClient = new TextractClient(config);
const dbClient = new DynamoDBClient(config);

/**
 * Main handler: receive event from S3 and return a response
 * This function react to a s3 trigger performing those steps:
 * STEP 1. get bucket and image key from event (this function is triggered by s3 on upload to /input folder)
 * STEP 2. pass image to textract analyzeId API to get identity info
 * STEP 2.1 put identity info on dynamodb
 * STEP 3. write a json and put an object with identity info to s3 (in a /output folder)
 * STEP 4. deleting original input image
 * STEP 5. return textract recognized identity info as response
 * @param event
 * @returns {Promise<{body: *|string, statusCode: *}>}
 */
module.exports.handler = async (event) => {

    /*Log trigger event*/
    console.log(event);

    /* STEP 1. Get bucket and image key from event */
    /* Get bucket name (it should be the bucket on which the trigger is active*/
    const bucketName = event['Records'][0]['s3']['bucket']['name'];
    /* Get key name (it should be a jpeg image)*/
    const keyName = event['Records'][0]['s3']['object']['key'];
    /* Log bucket and key names*/
    console.log(bucketName,keyName);

    /* STEP 2. Analyze an image with textract OCR */
    /* Prepare analyzeId command input passing s3 object info got from event*/
    const analyzeIDCommandInput = { // AnalyzeIDRequest
        DocumentPages: [ // DocumentPages // required
            { // Document
                S3Object: { // S3Object
                    Bucket: bucketName,
                    Name: keyName,
                },
            },
        ],
    };

    /* Execute analyzeId command with textract and get recognized info in a response */
    const analyzeIDCommand = new AnalyzeIDCommand(analyzeIDCommandInput);
    const analyzeIDCommandResponse = await textractClient.send(analyzeIDCommand);
    /* Log textract response */
    console.log(analyzeIDCommandResponse);

    let identity = extractIdentity(analyzeIDCommandResponse);

    /* STEP 2.1. Insert into dynamo DB identity */
    const docClient = DynamoDBDocumentClient.from(dbClient);
    const command = new ExecuteStatementCommand({
        Statement: `
            INSERT INTO identityTable value {
                'document_number':?,
                'document_number_confidence':?,
                'document_number_type':?,
                'first_name':?,
                'first_name_confidence':?,
                'first_name_type':?,
                'last_name':?,
                'last_name_confidence':?,
                'last_name_type':?,
                'expiration_date':?,
                'expiration_date_confidence':?,
                'expiration_date_type':?,
                'input':?
            }`,
        Parameters: [
            identity.DOCUMENT_NUMBER.text?identity.DOCUMENT_NUMBER.text:'not-found',
            identity.DOCUMENT_NUMBER.confidence?identity.DOCUMENT_NUMBER.confidence:0,
            identity.DOCUMENT_NUMBER.type?identity.DOCUMENT_NUMBER.type:'not-found',
            identity.FIRST_NAME.text?identity.FIRST_NAME.text:'not-found',
            identity.FIRST_NAME.confidence?identity.FIRST_NAME.confidence:0,
            identity.FIRST_NAME.type?identity.FIRST_NAME.type:'not-found',
            identity.LAST_NAME.text?identity.LAST_NAME.text:'not-found',
            identity.LAST_NAME.confidence?identity.LAST_NAME.confidence:0,
            identity.LAST_NAME.type?identity.LAST_NAME.type:'not-found',
            identity.EXPIRATION_DATE.text?identity.EXPIRATION_DATE.text:'not-found',
            identity.EXPIRATION_DATE.confidence?identity.EXPIRATION_DATE.confidence:0,
            identity.EXPIRATION_DATE.type?identity.EXPIRATION_DATE.type:'not-found',
            keyName
        ],
    });
    let executeStatementCommandResponse;
    try{
        executeStatementCommandResponse = await docClient.send(command);
        /* STEP 3. Write recognized info to a S3 json file */
        /* Transform textract response to a buffer */
        const analyzeIDCommandResponseBuffer = Buffer.from(
            JSON.stringify(
                {
                    identity:identity,
                    analyzed:analyzeIDCommandResponse
                }
            )
        );

        let responseKeyName = keyName.replace('input/','output/')
            .replace('.jpeg','.json')
            .replace('.jpg','.json');
        /* Prepare putObject command input to upload a file with textract response to s3*/
        const putObjectCommandInput = {
            Bucket: bucketName,
            Key: responseKeyName,
            Body: analyzeIDCommandResponseBuffer,
            ContentEncoding: 'base64',
            ContentType: 'application/json'
        };

        /* Execute putObject command and upload textract response to s3 */
        const putObjectCommand = new PutObjectCommand(putObjectCommandInput);
        const putObjectCommandResponse = await s3Client.send(putObjectCommand);

    } catch (e){
        console.log(e);
    }

    /* STEP 4. Delete original image */
    /* Prepare deleteObject input*/
    const deleteObjectInput = {
        Bucket: bucketName,
        Key: keyName
    };

    /* Execute delete command on original image */
    const deleteObjectCommand = new DeleteObjectCommand(deleteObjectInput);
    const deleteObjectCommandResponse = await s3Client.send(deleteObjectCommand);

    /* STEP 5. return textract recognized identity info as response*/
    /* Return textract response */
    return utils.prepareResponse(
        {
            message: {
                identity:identity,
                analyzed:analyzeIDCommandResponse,
                dynamo:executeStatementCommandResponse
            },
            input: event,
        }
        ,200
    );
};

/**
 * Extract Identity information from returned analyzed document of Textract
 * @param analyzeIDCommandResponse
 * @returns {{DOCUMENT_NUMBER: {text: string, type: string, confidence: int}, LAST_NAME: {text: string, type: string, confidence: int}, FIRST_NAME: {text: string, type: string, confidence: int}, EXPIRATION_DATE: {text: string, type: string, confidence: int}}}
 */
function extractIdentity(analyzeIDCommandResponse) {
    /* Get Name, Surname, Document Number and set identity*/
    let identity = {
        FIRST_NAME: {text: '', type: '', confidence: 0},
        LAST_NAME: {text: '', type: '', confidence: 0},
        DOCUMENT_NUMBER: {text: '', type: '', confidence: 0},
        EXPIRATION_DATE: {text: '', type: '', confidence: 0}
    };
    /* Check in recognized identityDocumentsFields */
    for (let i = 0; i < analyzeIDCommandResponse.IdentityDocuments.length; i++) {
        /* Get identityDocument */
        const identityDocument = analyzeIDCommandResponse.IdentityDocuments[i];
        /* Extract identity from identity document fields */
        extractFromIdentityDocumentFields(identityDocument, identity);
        /* Extract identity from identity document blocks */
        extractFromIdentityDocumentBlocks(identityDocument, identity);
    }
    return identity;
}

/**
 * Extract identity fields from document fields portion of analyzed document via Textract
 * which is able to return auto identified document fields of EU patent
 * In Textract response under IdentityDocumentFields section there are:
 * FIRST_NAME, which identify the name
 * LAST_NAME, which identify the surname
 * DOCUMENT_NUMBER, which identify the patent number
 * Those fields have got a confidence which we need to be more than 95%
 * @param identityDocument
 * @param identity
 */
function extractFromIdentityDocumentFields(identityDocument, identity) {
    /* Cycle fields */
    for (let j = 0; j < identityDocument.IdentityDocumentFields.length; j++) {
        /* Get field */
        const identityDocumentField = identityDocument.IdentityDocumentFields[j];
        /* If name, surname or document number are not empty and confidence is upper than 95 */
        if (
            (
                identityDocumentField.Type.Text === 'FIRST_NAME' //if type FIRST_NAME
                || identityDocumentField.Type.Text === 'LAST_NAME' //if type LAST_NAME
                || identityDocumentField.Type.Text === 'DOCUMENT_NUMBER' //if type DOCUMENT_NUMBER
                || identityDocumentField.Type.Text === 'EXPIRATION_DATE' //if type DOCUMENT_NUMBER
            )
            && identityDocumentField.ValueDetection.Confidence >= 95 // if confidence is more than 95%
            && identityDocumentField.ValueDetection.Text !== '' // if text is not empty
        ) {
            /* Set name, surname or document number in identity */
            identity[identityDocumentField.Type.Text]['text'] = identityDocumentField.ValueDetection.Text;
            //set as document-field to say we recognized it via document fields parsing
            identity[identityDocumentField.Type.Text]['type'] = 'document-field';
            identity[identityDocumentField.Type.Text]['confidence'] = identityDocumentField.ValueDetection.Confidence;
        }
        /* Exit if name,surname,expiration date and document number have been found */
        if (
            identity.FIRST_NAME['text']
            && identity.LAST_NAME['text']
            && identity.DOCUMENT_NUMBER['text']
            && identity.EXPIRATION_DATE['text']
        ) {
            break;
        }
    }
}

/**
 * Extract identity fields from block portion of analyzed document via Textract
 * This is a fallback if document fields have not been identified by Textract
 * In this case Textract returns Blocks, an array of blocks
 * with each identify a page, line or a word
 * As EU patent have got a strict format in which:
 * Statement "1." identifies surname (last name)
 * Statement "2." identifies name (first name)
 * Statement "5." identifies patent number (document number)
 * this function search for those patterns to identify information in the block in
 * which those patterns are present (or the subsequent ones)
 * @param identityDocument
 * @param identity
 */
function extractFromIdentityDocumentBlocks(identityDocument,identity) {
    /* If any of name, surname or document number is empty */
    if (
        !identity.FIRST_NAME['text']
        || !identity.LAST_NAME['text']
        || !identity.DOCUMENT_NUMBER['text']
    ) {
        /* Cycle blocks*/
        for (let j = 0; j < identityDocument.Blocks.length; j++) {
            /* Get the block */
            const block = identityDocument.Blocks[j];

            /* Check for "1. " as the last name in EU patent */
            /* If present and last name has not been set in identity, name should be after this */
            parseBlock(block,'LINE',j,'this','1. ',identity,'LAST_NAME',identityDocument);
            /* Check for "1." as the last name in EU patent */
            /* If present and last name has not been set, name should be the text in sequent block*/
            parseBlock(block,'LINE',j+1,'next','1.',identity,'LAST_NAME',identityDocument);

            /* Check for "2. " as the surname in EU patent */
            /* If present and surname has not been set in identity, name should be after this */
            parseBlock(block,'LINE',j,'this','2. ',identity,'FIRST_NAME',identityDocument);
            /* Check for "2." as the surname in EU patent */
            /* If present and surname has not been set, name should be the text in sequent block*/
            parseBlock(block,'LINE',j+1,'next','2.',identity,'FIRST_NAME',identityDocument);

            /* Check for "4b. " as the expiration date in EU patent */
            /* If present and expiration date has not been set in identity, name should be after this */
            parseBlock(block,'LINE',j,'this','4b. ',identity,'EXPIRATION_DATE',identityDocument);
            /* Check for "2." as the surname in EU patent */
            /* If present and expiration date has not been set, name should be the text in sequent block*/
            parseBlock(block,'LINE',j+1,'next','4b.',identity,'EXPIRATION_DATE',identityDocument);

            /* Check for "5. " as document number in EU patent */
            /* If present and document number has not been set in identity, name should be after this */
            parseBlock(block,'LINE',j,'this','5. ',identity,'DOCUMENT_NUMBER',identityDocument);
            /* Check for "5." as the document number in EU patent */
            /* If present and document number has not been set, name should be the text in sequent block*/
            parseBlock(block,'LINE',j+1,'next','5.',identity,'DOCUMENT_NUMBER',identityDocument);
            // Exit if name,surname,expiration date and document number have been found
            if (
                identity.FIRST_NAME['text']
                && identity.LAST_NAME['text']
                && identity.DOCUMENT_NUMBER['text']
                && identity.EXPIRATION_DATE['text']
            ) {
                break;
            }
        }
    }
}

/**
 * Utility function to parse a single block using the block itself using
 * @param block
 * @param blockType
 * @param blockIndex
 * @param blockContainer
 * @param include
 * @param identity
 * @param identityField
 */
function parseBlock(block, blockType, blockIndex, blockContainer, include, identity, identityField, identityDocument) {
    if (
        block.BlockType === blockType //blockType is 'PAGE', 'LINE' or 'WORD'
        &&
        (
            blockContainer==='this' && block.Text.includes(include) //include is the pattern to be match in the block ("1. ")
            || blockContainer==='next' && block.Text === include //include is the pattern to be equal in the block ("1.")
        )
        && !identity[identityField]['text']) //identityField is 'FIRST_NAME','LAST_NAME' or 'DOCUMENT_NUMBER'
    {
        //blockContainer is 'this' or 'next' to identify which
        // block of the array from which we should get the text
        if(blockContainer==='this'){
            //if we should get text from this block, the info is in the second part of the string, splitted by include
            identity[identityField]['text'] = block.Text.split(include)[1];
        }else{
            //if we should get text from next block, the info is actually the text of the next block
            identity[identityField]['text'] = identityDocument.Blocks[blockIndex].Text;
        }
        //we set type of this identityField to block to set that we recognized it via block parsing
        identity[identityField]['confidence'] = identityDocument.Blocks[blockIndex].Confidence;
        identity[identityField]['type'] = 'block';
    }
}
