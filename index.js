'use strict';

const axios = require("axios");
const url = require("url");
const xsenv = require("@sap/xsenv");
const https = require("https");
const nodemailer = require("nodemailer");
const hdbext = require("@sap/hdbext");
const dns = require('dns');
const crypto = require('crypto');
const algorithm = "aes-192-cbc";
const secret = "my-secret-key";
const key = crypto.scryptSync(secret, 'salt', 24);
const iv = crypto.randomBytes(16);

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

let config = {
  httpsAgent,
  method: "post",
  withCredentials: true,
  headers: {
    "Content-Type": "application/json"
  }
};

exports.validateRequest = async function(req, options, callback) {
  console.log("## Calling validateRequest.");
  try {
    if (typeof options !== "object") {
      return callback("Enter the correct options which type is object.");
    }
    // Validating data which comes in request and options object.
    let auditData = await validateInputData(req, options);
    // Finding application enable flag
    let applicationEnableFlag = await checkApplicationEnableFlag(auditData);

    if (!applicationEnableFlag) {
      auditData.APP_ENABLE_FLAG = false;
      return callback(null, {
        "auditData": auditData
      });
    }

    auditData.APP_ENABLE_FLAG = true;
    auditData.VALIDATE_ROUTE = auditData.APP_XSA_JOBS.APIMgmtHost + auditData.APP_XSA_JOBS.validateInboundRoute;
    auditData.AUDIT_ROUTE = auditData.APP_XSA_JOBS.APIMgmtHost + auditData.APP_XSA_JOBS.auditInboundRoute;
    config.auth = {
      "username": auditData.APP_XSA_JOBS.userName,
      "password": auditData.APP_XSA_JOBS.password
    };

    const userAndPass = auditData.APP_XSA_JOBS.userName + "<@#@#@>" + auditData.APP_XSA_JOBS.password;
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    auditData.ENCRYPTED = cipher.update(userAndPass, 'utf8', 'hex') + cipher.final('hex');
    delete auditData.SERVICES;

    // Calling framework to validate request.
    console.log("## Calling Framework : " + auditData.VALIDATE_ROUTE + " ##");
    axios.post(auditData.VALIDATE_ROUTE, {
        "auditData": auditData
      }, config)
      .then(function(resp) {
        console.log("## Successfully validated request in App Integration Management Framework.");
        auditData.REQUESTID = (resp && resp.data && resp.data.REQUESTID) ? resp.data.REQUESTID : null;
        delete auditData.SMTP_EMAIL_UPS;
        delete auditData.APP_XSA_JOBS;
        return callback(null, {
          "auditData": auditData
        });
      })
      .catch(function(error) {
        auditData.APP_ENABLE_FLAG = false;
        if (error.response && error.response.status && error.response.status > 500) {
          // If App Integration Management Framework is not reachable then skipping validation but executing HANA model and sending email.
          console.log("## App Integration Management Framework is Not Reachable, Skipping Validation.");
          console.log("## Status code : " + error.response.status);
          console.log("## Error.response.headers : " + error.response.headers);
          // Sending failure email if framework server is down/not responding.
          sendFailureEmail(auditData, (emailError, emailResp) => {
            delete auditData.SMTP_EMAIL_UPS;
            delete auditData.APP_XSA_JOBS;
            return callback(null, {
              "auditData": auditData
            });
          });
        } else if (error.response && error.response.data) {
          // If App Integration Management Framework reachable then not executing HANA model, Sending error back to mendix.
          return callback(error.response.data);
        } else {
          // Something happened in setting up the request that triggered an Error
          console.log("## Error to calling framework : " + error.message);
          auditData.ERROR = error.message;
          // Sending failure email if framework server is down/not responding.
          sendFailureEmail(auditData, (emailError, emailResp) => {
            delete auditData.SMTP_EMAIL_UPS;
            delete auditData.APP_XSA_JOBS;
            return callback(null, {
              "auditData": auditData
            });
          });
        }
      });
  } catch (throwingError) {
    console.log('## Inside validateRequest catch.');
    console.log(throwingError);
    callback(throwingError);
  }
};

// Function for to save the audit log details after executed HANA model.
exports.saveAuditDetails = function(req, res, RECORDCOUNT) {
  console.log("## Calling saveAuditDetails.");
  try {
    let auditData = {};
    if (req && req.auditData) {
      auditData = req.auditData;
    }

    if (auditData && auditData.APP_ENABLE_FLAG) {
      auditData.RECORDCOUNT = RECORDCOUNT ? RECORDCOUNT : null;
      auditData.HANASTATUS = (res.statusCode == "200" || res.statusCode == 200) ? "SUCCESS" : "FAILED";
      auditData.ERRORDETAILS = res.statusMessage ? res.statusMessage : "";
      const decipher = crypto.createDecipheriv(algorithm, key, iv);
      var DECRYPTED = decipher.update(auditData.ENCRYPTED, 'hex', 'utf8') + decipher.final('utf8');
      config.auth = {
        "username": DECRYPTED.split("<@#@#@>")[0],
        "password": DECRYPTED.split("<@#@#@>")[1]
      };

      console.log("## Calling Framework : " + auditData.AUDIT_ROUTE + " ###");
      axios.post(auditData.AUDIT_ROUTE, {
          "auditData": auditData
        }, config)
        .then(function(resp) {
          console.log(`## Successfully saved audit details for request ID : "${auditData.REQUESTID}"`);
          if (resp && resp.data) {
            console.log(resp.data);
          }
        })
        .catch(function(error) {
          console.log(`## Error to saving audit details for request ID : "${auditData.REQUESTID}"`);
          console.log(error);
        });
    } else {
      console.log("## Application enable flag is not enabled, Skipping audit log store data.");
    }
  } catch (throwingError) {
    console.log('## Inside catch of saveAuditDetails.');
    console.log(throwingError);
  }
}

// Function for validate request and options object data.
function validateInputData(req, options) {
  console.log("## Calling validateInputData.");
  return new Promise((resolve, reject) => {
    let temp = {};
    temp.APPNAME = "";
    temp.FUNCTIONNAME = "";
    temp.IPADDRESS = "";
    temp.PARAMETER = "";
    temp.HOSTDNS = "";
    temp.ENVIRONMENT = "";

    if (!options.VCAP_APPLICATION) {
      reject("Please enter the VCAP_APPLICATION object in options.");
    }

    if (!options.VCAP_SERVICES) {
      reject("Please enter the VCAP_SERVICES object in options.");
    }

    if (!options.APP_XSA_JOBS) {
      reject("Please enter the app xsa jobs ups object in options.");
    } else {
      temp.APP_XSA_JOBS = options.APP_XSA_JOBS;
    }

    if (!options.SMTP_EMAIL_UPS) {
      reject("Please enter the smtp email ups object in options.");
    } else {
      temp.SMTP_EMAIL_UPS = options.SMTP_EMAIL_UPS;
    }

    if (!options.SERVICES) {
      reject("Please enter the SERVICES object in options.");
    } else {
      temp.SERVICES = options.SERVICES;
    }

    // Getting application name.
    if (options.APPNAME) {
      temp.APPNAME = options.APPNAME;
    } else if (options.VCAP_APPLICATION) {
      temp.APPNAME = options.VCAP_APPLICATION.application_name.split("-")[0].toUpperCase();
    } else {
      reject("Not able to get the APPNAME from VCAP_APPLICATION object or options object.");
    }

    // Getting API name from request object.
    if (options.FUNCTIONNAME) {
      temp.FUNCTIONNAME = options.FUNCTIONNAME;
    } else if (req) {
      temp.FUNCTIONNAME = (url.parse(req.url).pathname).split("/").pop() || ("/");
    } else {
      reject("Not able to get the FUNCTIONNAME from req object or options object.");
    }

    // Getting IPADDRESS from request object.
    if (options.IPADDRESS) {
      temp.IPADDRESS = options.IPADDRESS;
    } else if (req) {
      temp.IPADDRESS = (req.header("x-forwarded-for")) ? req.header("x-forwarded-for") : req.connection.remoteAddress;
    } else {
      reject("Not able to get the IPADDRESS from req object or options object.");
    }

    // Getting request body from request object.
    if (options.PARAMETER) {
      temp.PARAMETER = options.PARAMETER;
    } else if (req) {
      temp.PARAMETER = req.body ? req.body : {};
    } else {
      reject("Not able to get the PARAMETER from req object or options object.");
    }

    // Getting host dns from request object.
    if (options.HOSTDNS) {
      temp.HOSTDNS = options.HOSTDNS;
    } else if (req) {
      dns.reverse(req.connection.remoteAddress, function(err, domains) {
        temp.HOSTDNS = (domains && domains[0]) ? domains[0] : req.headers.host;
      });
    }

    // Getting Host Dns name from request object.
    if (options.HOSTDNS) {
      temp.HOSTDNS = options.HOSTDNS;
    } else if (req) {
      dns.reverse(req.connection.remoteAddress, function(err, domains) {
        temp.HOSTDNS = (domains && domains[0]) ? domains[0] : req.headers.host;
      });
    } else {
      reject("Not able to get the HOSTDNS from req object or options object.");
    }

    // Getting ENVIRONMENT name from service object.
    if (options.ENVIRONMENT) {
      temp.ENVIRONMENT = options.ENVIRONMENT;
    } else if (options.VCAP_SERVICES) {
      temp.ENVIRONMENT = options.VCAP_SERVICES.hana[0].credentials.tenant_name;
    } else {
      reject("Not able to get the ENVIRONMENT from service object or options object.");
    }
    resolve(temp);
  });
}

// Function for checking application enable flag.
function checkApplicationEnableFlag(auditData) {
  console.log("## Calling checkApplicationEnableFlag.");

  return new Promise((resolve, reject) => {
    var query = `select "VARIABLE_VALUE" from "EBI"."T_IM_GLOBAL_VARIABLE"
    where ("APP_NAME"='${auditData.APPNAME}') AND 
    ("FUNCTION_NAME"='GLOBAL') AND
    ("REQUEST_TYPE"='INBOUND') AND
    ("VARIABLE_NAME"='APPLICATION_ENABLE_FLAG')`;

    hdbext.createConnection(auditData.SERVICES.hanaConfig, (connectionError, client) => {
      if (connectionError) {
        client.close();
        console.log("[ERROR]: Connection error in checkApplicationEnableFlag function.");
        reject(connectionError);
      } else {
        client.exec(query, (queryError, result) => {
          client.close();
          if (result && result[0] && result[0].VARIABLE_VALUE) {
            console.log(`## Application Enable Flag For APPNAME : "${auditData.APPNAME}" is : "${result[0].VARIABLE_VALUE}"`);
            if (result[0].VARIABLE_VALUE == 'TRUE' || result[0].VARIABLE_VALUE == 'true') {
              resolve(true);
            } else {
              resolve(false);
            }
          } else {
            reject(`[ERROR]: While Getting Application Enable Flag For APPNAME : "${auditData.APPNAME}"`);
          }
        });
      }
    });
  });
}

// Function for to send the failure email.
function sendFailureEmail(auditData, callback) {
  console.log("## Calling sendFailureEmail.");
  try {
    const transporter = nodemailer.createTransport(auditData.SMTP_EMAIL_UPS);
    const mailOptions = {
      "from": auditData.APP_XSA_JOBS.mailForm,
      "to": auditData.APP_XSA_JOBS.failureMailTo,
      "subject": `${auditData.ENVIRONMENT} - APP_INTEGRATION_MANAGEMENT: Error for ${auditData.APPNAME} Application`,
      "html": `Dear User,<br/>
                  <br/> <b>APP NAME:</b> ${auditData.APPNAME}
                  <br/> <b>MESSAGE:</b>  Validation of inbound request failed !!
                  <br/> <b>ERROR DETAILS:</b> App Integration Management Framework is Not Reachable.
                  <br/> 
                  <br/> This is a auto generated message, please do not reply
                  <br/> Regards`
    };

    console.log("## Mail options to send email.");
    console.log(mailOptions);

    transporter.sendMail(mailOptions, function(error, info) {
      if (error) {
        console.log("## Error to sending email.");
        console.log(error);
      } else {
        console.log("## Email sent to : " + auditData.APP_XSA_JOBS.failureMailTo);
        console.log(info);
      }
      callback(null);
    });
  } catch (throwingError) {
    console.log("## Error to sending email : " + throwingError);
    console.log(throwingError);
    callback(null);
  }
}