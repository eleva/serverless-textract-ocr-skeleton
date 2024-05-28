require('dotenv').config()
// Load the AWS SDK for Node.js.
var AWS = require("aws-sdk");
// Set the AWS Region.
AWS.config.update(
    {
        region: process.env.AWS_REGION, // Change this to your desired AWS region
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        }
    }
);

// Create DynamoDB service object.
var ddb = new AWS.DynamoDB({ apiVersion: "2012-08-10" });

const params = {
    TableName: "identityTable",
};

ddb.scan(params, function (err, data) {
    if (err) {
        console.log("Error", err);
    } else {
        let confidence = {total:0,document_number:0,first_name:0,last_name:0,expiration_date:0};
        data.Items.forEach(function (element, index, array) {

            confidence = {
                document_number: confidence.document_number+parseFloat(element.document_number_confidence.N),
                first_name: confidence.first_name+parseFloat(element.first_name_confidence.N),
                last_name: confidence.last_name+parseFloat(element.last_name_confidence.N),
                expiration_date: confidence.expiration_date+parseFloat(element.expiration_date_confidence.N),
            }

            if(index!==0){
                confidence = {
                    document_number: confidence.document_number/2,
                    first_name: confidence.first_name/2,
                    last_name: confidence.last_name/2,
                    expiration_date: confidence.expiration_date/2,
                }
            }

        });

        confidence.total = (confidence.document_number+confidence.first_name+confidence.last_name+confidence.expiration_date)/4
        console.log(confidence);
    }
});

