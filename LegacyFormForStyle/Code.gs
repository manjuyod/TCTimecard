/**
 * Google Apps Script server-side code for the Time-Off Request Form.
 */

/**
 * Serves the HTML file for the web app.
 * This function is required for any web app.
 *
 * @param {Object} e The event parameter for a web app doGet request.
 * @returns {HtmlOutput} The HTML output for the web app.
 */
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('WebApp')
      .setTitle('Time Off Request Form')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/**
 * Processes the form submission from the client-side.
 * This function is called by `google.script.run.processForm()`.
 *
 * @param {Object} formData The form data object from the client.
 * @returns {Object} A success or failure object.
 */
function processForm(formData) {
  try {
    // Log the received data for debugging
    console.log('Form data received:', JSON.stringify(formData, null, 2));

    // Example: Send an email notification
    const recipient = 'bmillare@tutoringclub.com'; // Replace with the supervisor's email
    const subject = `Time Off Request from ${formData.employeeName}`;
    let body = 'A new time-off request has been submitted.\n\n';
    body += `Employee: ${formData.employeeName}\n`;
    body += `Submission Date: ${formData.todaysDate}\n`;
    body += `Start Date: ${formData.startDate}\n`;
    body += `End Date: ${formData.endDate}\n`;
    body += `Absence Type: ${formData.absenceType}\n`;
    if (formData.absenceType === 'other') {
      body += `Other Type: ${formData.otherAbsenceType}\n`;
    }
    body += `Reason: ${formData.reason}\n`;

    if (formData.partialDay) {
        body += `Partial Day: Yes\n`;
        body += `Leave Time: ${formData.leaveTime}\n`;
        body += `Return Time: ${formData.returnTime}\n`;
    }

    // You can't directly attach the signature image data URL in a simple email.
    // A more advanced implementation would save the signature as a file in Google Drive
    // and link to it, or embed it in a more complex HTML email.
    // For now, we'll just acknowledge that it was signed.
    if (formData.employeeSignatureData) {
        body += '\nEmployee Signature: [SIGNED]\n';
    }

    MailApp.sendEmail(recipient, subject, body);

    // You could also save the data to a Google Sheet here.
    // For example:
    // const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Requests');
    // sheet.appendRow([
    //   new Date(),
    //   formData.employeeName,
    //   formData.startDate,
    //   formData.endDate,
    //   formData.absenceType,
    //   formData.reason
    // ]);

    return { success: true, message: 'Form submitted successfully!' };

  } catch (error) {
    console.error('Error in processForm:', error);
    return { success: false, message: 'An error occurred: ' + error.message };
  }
}