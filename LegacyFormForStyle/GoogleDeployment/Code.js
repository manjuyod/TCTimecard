/**
 * Google Apps Script server-side code for a multi-center Time-Off Request Form.
 * Includes security enhancements: token-based approval and input sanitization.
 */

// --- CONFIGURATION ---
const SPREADSHEET_URL = 'https://docs.google.com/spreadsheets/d/1R5DPTeLXQgr2XifhEXDLRXhnDzphW7np5PSNLs3i2LU/edit';
const REQUESTS_SHEET_NAME = 'Requests';

const CENTERS_CONFIG = [
  { id: '0', name: 'Corp/Directors', email: 'dpinkney@tutoringclub.com' },
  { id: '1', name: 'Tutoring Club User', email: 'bmillares@tutoringclub.com' },
  { id: '6', name: 'Anthem', email: 'anthemnv@tutoringclub.com' },
  { id: '57', name: 'Tutoring Club of Gilbert', email: 'gilbertaz@tutoringclub.com' },
  { id: '11', name: 'Green Valley', email: 'hendersonnv@tutoringclub.com' },
  { id: '15', name: 'North Las Vegas', email: 'northlasvegasnv@tutoringclub.com' },
  { id: '16', name: 'Rhodes Ranch', email: 'rhodesranchnv@tutoringclub.com' },
  { id: '60', name: 'Centennial', email: 'centennial@tutoringclub.com' }
];

// --- CONSTANTS FOR SPREADSHEET COLUMNS ---
const COL = {
  REQUEST_ID: 1,
  TIMESTAMP: 2,
  EMPLOYEE_NAME: 3,
  EMPLOYEE_EMAIL: 4,
  CENTER_NAME: 5,
  START_DATE: 6,
  END_DATE: 7,
  ABSENCE_TYPE: 8,
  REASON: 9,
  STATUS: 10,
  APPROVAL_TOKEN: 11 // New column for the secure token
};

/**
 * Sanitizes user input to prevent XSS attacks by escaping HTML characters.
 * @param {string} input The string to sanitize.
 * @returns {string} The sanitized string.
 */
function sanitize(input) {
  if (!input) return '';
  return input.toString().replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Main function to handle GET requests for both the form and approval actions.
 */
function doGet(e) {
  if (e.parameter.action && e.parameter.id && e.parameter.token) {
    return handleApprovalAction(e);
  }

  const centerId = e.parameter.center;
  if (!centerId) {
    return HtmlService.createHtmlOutput('<h1>Error</h1><p>No center specified. Please use a valid link with a center ID (e.g., .../exec?center=1).</p>');
  }

  const center = CENTERS_CONFIG.find(c => c.id === centerId);
  if (!center) {
    return HtmlService.createHtmlOutput(`<h1>Error</h1><p>Invalid center ID provided: ${sanitize(centerId)}.</p>`);
  }

  const template = HtmlService.createTemplateFromFile('WebApp');
  template.center = center;
  return template.evaluate()
      .setTitle(`Time Off Request - ${center.name}`)
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/**
 * Processes the initial form submission from the client-side.
 */
function processForm(formData) {
  try {
    const center = CENTERS_CONFIG.find(c => c.id === formData.centerId);
    if (!center) {
      throw new Error(`Invalid centerId submitted: ${formData.centerId}`);
    }

    // --- Sanitize all user inputs ---
    const cleanData = {
      employeeName: sanitize(formData.employeeName),
      employeeEmail: sanitize(formData.employeeEmail),
      startDate: sanitize(formData.startDate),
      endDate: sanitize(formData.endDate),
      absenceType: sanitize(formData.absenceType),
      reason: sanitize(formData.reason)
    };

    const sheet = getRequestsSheet();
    const approvalToken = Utilities.getUuid(); // Generate a unique, unguessable token

    const newRow = sheet.appendRow([
      '', // Placeholder for Request ID
      new Date(),
      cleanData.employeeName,
      cleanData.employeeEmail,
      center.name,
      cleanData.startDate,
      cleanData.endDate,
      cleanData.absenceType,
      cleanData.reason,
      'Pending',
      approvalToken // Store the token in the new column
    ]);
    
    const requestId = newRow.getLastRow();
    sheet.getRange(requestId, COL.REQUEST_ID).setValue(requestId);

    sendApprovalEmail(cleanData, requestId, center, approvalToken);

    return { success: true, message: 'Form submitted successfully! Awaiting supervisor approval.' };

  } catch (error) {
    console.error('Error in processForm: ' + error.toString());
    return { success: false, message: 'An error occurred: ' + error.message };
  }
}

/**
 * Handles the supervisor's approval or denial click from the email.
 */
function handleApprovalAction(e) {
  const action = e.parameter.action;
  const requestId = e.parameter.id;
  const providedToken = e.parameter.token;

  if (!providedToken) {
      return HtmlService.createHtmlOutput(`<div style="font-family: sans-serif; padding: 20px; text-align: center; color: #e74c3c;"><h1>Invalid Link</h1><p>The approval link is missing a required security token.</p></div>`);
  }
  
  try {
    const sheet = getRequestsSheet();
    const requestRow = parseInt(requestId);
    
    // --- Security Check: Verify Token ---
    const storedToken = sheet.getRange(requestRow, COL.APPROVAL_TOKEN).getValue();
    if (!storedToken || storedToken !== providedToken) {
      return HtmlService.createHtmlOutput(`<div style="font-family: sans-serif; padding: 20px; text-align: center; color: #e74c3c;"><h1>Invalid or Expired Link</h1><p>This approval link is not valid. It may have already been used.</p></div>`);
    }
    
    const status = sheet.getRange(requestRow, COL.STATUS).getValue();
    if (status !== 'Pending') {
      return HtmlService.createHtmlOutput(`<div style="font-family: sans-serif; padding: 20px; text-align: center;"><h1>Action Already Taken</h1><p>This request has already been ${status.toLowerCase()}.</p></div>`);
    }
    
    const requestData = getRequestDataById(sheet, requestRow);
    const center = CENTERS_CONFIG.find(c => c.name === requestData.centerName);
    if (!center) {
      throw new Error(`Could not find configuration for center: ${requestData.centerName}`);
    }
    
    // Clear the token so the link cannot be reused
    sheet.getRange(requestRow, COL.APPROVAL_TOKEN).setValue('');

    if (action === 'approve') {
      createCalendarEvent(requestData, center.email);
      MailApp.sendEmail(requestData.employeeEmail, 'Time-Off Request Approved', `Hi ${requestData.employeeName},\n\nYour time-off request for ${requestData.startDate} to ${requestData.endDate} has been approved.`);
      sheet.getRange(requestRow, COL.STATUS).setValue('Approved');
      return HtmlService.createHtmlOutput(`<div style="font-family: sans-serif; padding: 20px; text-align: center; color: #28a745;"><h1>Request Approved</h1><p>The request for <strong>${requestData.employeeName}</strong> has been approved.</p></div>`);
      
    } else if (action === 'decline') {
      MailApp.sendEmail(requestData.employeeEmail, 'Time-Off Request Declined', `Hi ${requestData.employeeName},\n\nUnfortunately, your time-off request for ${requestData.startDate} to ${requestData.endDate} has been declined.`);
      sheet.getRange(requestRow, COL.STATUS).setValue('Declined');
      return HtmlService.createHtmlOutput(`<div style="font-family: sans-serif; padding: 20px; text-align: center; color: #e74c3c;"><h1>Request Declined</h1><p>The request for <strong>${requestData.employeeName}</strong> has been declined.</p></div>`);
    }
    
  } catch (error) {
    console.error('Error in handleApprovalAction:', error.toString());
    return HtmlService.createHtmlOutput(`<div style="font-family: sans-serif; padding: 20px; text-align: center; color: #e74c3c;"><h1>Error</h1><p>An error occurred: ${error.message}</p></div>`);
  }
}

/**
 * Sends a secure HTML email to the supervisor with Approve/Decline buttons.
 */
function sendApprovalEmail(formData, requestId, center, token) {
  const webAppUrl = ScriptApp.getService().getUrl();
  // Add the secure token to the URLs
  const approveUrl = `${webAppUrl}?action=approve&id=${requestId}&token=${token}`;
  const declineUrl = `${webAppUrl}?action=decline&id=${requestId}&token=${token}`;
  
  const subject = `Time Off Request from ${formData.employeeName} (${center.name})`;
  
  const plainTextBody = `
    A new time-off request has been submitted.
    Center: ${center.name}
    Employee: ${formData.employeeName}
    Email: ${formData.employeeEmail}
    Dates Requested: ${formData.startDate} to ${formData.endDate}
    Reason: ${formData.reason}

    Please approve or decline by clicking the links below:
    Approve: ${approveUrl}
    Decline: ${declineUrl}
  `;
  
  const htmlBody = `
    <div style="font-family: sans-serif; font-size: 14px; line-height: 1.6;">
      <h2 style="color: #487cb6;">New Time-Off Request</h2>
      <p><strong>Center:</strong> ${center.name}</p>
      <p><strong>Employee:</strong> ${formData.employeeName}</p>
      <p><strong>Email:</strong> ${formData.employeeEmail}</p>
      <p><strong>Dates Requested:</strong> ${formData.startDate} to ${formData.endDate}</p>
      <p><strong>Reason:</strong> <em>${formData.reason}</em></p>
      <hr>
      <table border="0" cellpadding="0" cellspacing="0"><tr>
        <td align="center" style="padding: 10px;"><a href="${approveUrl}" style="background-color: #28a745; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px;">Approve</a></td>
        <td align="center" style="padding: 10px;"><a href="${declineUrl}" style="background-color: #e74c3c; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px;">Decline</a></td>
      </tr></table>
    </div>`;
  
  MailApp.sendEmail(center.email, subject, plainTextBody, { 
    htmlBody: htmlBody 
  });
}

/**
 * Creates a Google Calendar event on the specified calendar.
 */
function createCalendarEvent(requestData, calendarId) {
  const calendar = CalendarApp.getCalendarById(calendarId);
  if (!calendar) {
    throw new Error(`Could not find calendar for ID: ${calendarId}`);
  }
  const title = `Time Off: ${requestData.employeeName}`;
  const startDate = new Date(requestData.startDate);
  const endDate = new Date(requestData.endDate);
  endDate.setDate(endDate.getDate() + 1);
  calendar.createAllDayEvent(title, startDate, endDate, { description: `Reason: ${requestData.reason}` });
}

/**
 * Retrieves the central Google Sheet for storing requests.
 */
function getRequestsSheet() {
  try {
    const spreadsheet = SpreadsheetApp.openByUrl(SPREADSHEET_URL);
    const sheet = spreadsheet.getSheetByName(REQUESTS_SHEET_NAME);
    if (!sheet) {
      return spreadsheet.insertSheet(REQUESTS_SHEET_NAME);
    }
    return sheet;
  } catch (e) {
    console.error("Could not open spreadsheet. Make sure the URL is correct and the script has access.", e);
    throw new Error("Unable to access the central requests spreadsheet.");
  }
}

/**
 * Retrieves a row of data from the sheet by its ID.
 */
function getRequestDataById(sheet, rowNumber) {
  // Read all columns up to the token column
  const values = sheet.getRange(rowNumber, 1, 1, COL.APPROVAL_TOKEN).getValues()[0];
  return {
    requestId: values[COL.REQUEST_ID - 1],
    timestamp: values[COL.TIMESTAMP - 1],
    employeeName: values[COL.EMPLOYEE_NAME - 1],
    employeeEmail: values[COL.EMPLOYEE_EMAIL - 1],
    centerName: values[COL.CENTER_NAME - 1],
    startDate: values[COL.START_DATE - 1],
    endDate: values[COL.END_DATE - 1],
    absenceType: values[COL.ABSENCE_TYPE - 1],
    reason: values[COL.REASON - 1],
    status: values[COL.STATUS - 1]
    // We don't return the token here for security
  };
}
