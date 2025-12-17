/**
 * Dynamic Time-Off Request Form
 * Progressive revelation functionality and email integration
 */

// Form state management
let formSections = {
    'section-employee-info': { visible: true, completed: false },
    'section-calendar': { visible: false, completed: false },
    'section-absence-type': { visible: false, completed: false },
    'section-reason': { visible: false, completed: false },
    'section-signature': { visible: false, completed: false }
};

// Initialize dynamic form functionality
document.addEventListener('DOMContentLoaded', function() {
    initializeDynamicForm();
    bindDynamicEventListeners();
    setDefaultValues();
});

/**
 * Initialize dynamic form functionality
 */
function initializeDynamicForm() {
    // Set up progressive revelation
    setupProgressiveRevealation();
    
    // Initialize the first section as visible
    showSection('section-employee-info');
}

/**
 * Bind event listeners for dynamic functionality
 */
function bindDynamicEventListeners() {
    // Employee Information section
    document.getElementById('employeeName').addEventListener('blur', validateEmployeeSection);
    document.getElementById('todaysDate').addEventListener('change', validateEmployeeSection);
    
    // Calendar section
    document.getElementById('startDate').addEventListener('change', validateCalendarSection);
    document.getElementById('endDate').addEventListener('change', validateCalendarSection);
    document.getElementById('partialDay').addEventListener('change', handlePartialDayToggle);
    
    // Absence Type section
    document.querySelectorAll('input[name="absenceType"]').forEach(radio => {
        radio.addEventListener('change', handleAbsenceTypeChange);
    });
    
    // Reason section
    document.getElementById('reason').addEventListener('blur', validateReasonSection);
    
    // Signature section - will be handled by existing signature pad code
    
    // Other absence type handling
    document.querySelector('input[value="other"]').addEventListener('change', function() {
        const otherInput = document.getElementById('otherAbsenceType');
        if (this.checked) {
            otherInput.style.display = 'block';
            otherInput.disabled = false;
            otherInput.required = true;
        } else {
            otherInput.style.display = 'none';
            otherInput.disabled = true;
            otherInput.required = false;
        }
    });
}

/**
 * Set default values
 */
function setDefaultValues() {
    // Set today's date
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('todaysDate').value = today;
    document.getElementById('employeeSignatureDate').value = today;
}

/**
 * Progressive revelation setup
 */
function setupProgressiveRevealation() {
    // Hide all sections except the first one
    Object.keys(formSections).forEach(sectionId => {
        const section = document.getElementById(sectionId);
        if (section && !formSections[sectionId].visible) {
            section.style.display = 'none';
            section.classList.remove('visible');
        }
    });
}

/**
 * Show a section with animation
 */
function showSection(sectionId) {
    const section = document.getElementById(sectionId);
    if (section && !formSections[sectionId].visible) {
        formSections[sectionId].visible = true;
        
        // Show the section
        section.style.display = 'block';
        
        // Trigger animation and initialization after a small delay
        setTimeout(() => {
            section.classList.add('visible');
            section.scrollIntoView({ behavior: 'smooth', block: 'center' });

            // If this is the signature section, initialize the signature pad
            if (sectionId === 'section-signature' && typeof window.initializeSignaturePads === 'function') {
                requestAnimationFrame(() => {
                    window.initializeSignaturePads();
                });
            }
        }, 100);
    }
}

/**
 * Validate employee information section
 */
function validateEmployeeSection() {
    const name = document.getElementById('employeeName').value.trim();
    const date = document.getElementById('todaysDate').value;
    
    if (name && date) {
        formSections['section-employee-info'].completed = true;
        showSection('section-calendar');
    }
}

/**
 * Validate calendar section
 */
function validateCalendarSection() {
    const startDate = document.getElementById('startDate').value;
    const endDate = document.getElementById('endDate').value;
    
    if (startDate && endDate) {
        // Validate date logic
        const start = new Date(startDate);
        const end = new Date(endDate);
        
        if (start <= end) {
            formSections['section-calendar'].completed = true;
            showSection('section-absence-type');
        }
    }
}

/**
 * Handle partial day toggle
 */
function handlePartialDayToggle() {
    const isPartial = document.getElementById('partialDay').checked;
    const partialSection = document.getElementById('partialDaySection');
    
    if (isPartial) {
        partialSection.style.display = 'block';
    } else {
        partialSection.style.display = 'none';
        // Clear time values
        document.getElementById('leaveTime').value = '';
        document.getElementById('returnTime').value = '';
    }
}

/**
 * Handle absence type change
 */
function handleAbsenceTypeChange(event) {
    const selectedType = event.target.value;
    
    if (selectedType) {
        formSections['section-absence-type'].completed = true;
        showSection('section-reason');
    }
}

/**
 * Validate reason section
 */
function validateReasonSection() {
    const reason = document.getElementById('reason').value.trim();
    
    if (reason && reason.length >= 10) {
        formSections['section-reason'].completed = true;
        showSection('section-signature');
    }
}

/**
 * Handle signature completion (to be called from existing signature code)
 */
function handleSignatureComplete() {
    const signatureDate = document.getElementById('employeeSignatureDate').value;
    const hasSignature = window.employeeSignaturePad && !window.employeeSignaturePad.isEmpty();
    
    if (signatureDate && hasSignature) {
        formSections['section-signature'].completed = true;
        // No longer showing a new section, just enabling the button.
        const submitBtn = document.getElementById('finalSubmitBtn');
        if(submitBtn) {
            submitBtn.disabled = false;
        }
    }
}

/**
 * Generate email preview
 */
function generateEmailPreview() {
    const formData = collectFormData();
    
    // Update supervisor email based on form data or configuration
    const supervisorEmail = document.getElementById('supervisorEmail');
    supervisorEmail.textContent = 'bmillare@tutoringclub.com'; // Test email as specified
    
    return formData;
}

/**
 * Enhanced form submission with email functionality
 */
async function submitDynamicForm(event) {
    event.preventDefault();
    
    // Validate all sections are complete
    const allCompleted = Object.values(formSections).every(section => section.completed);
    
    if (!allCompleted) {
        alert('Please complete all sections before submitting.');
        return;
    }
    
    const formData = generateEmailPreview();
    
    // Show loading state
    const submitButton = document.querySelector('.submit-btn');
    const originalText = submitButton.textContent;
    submitButton.textContent = 'Sending...';
    submitButton.disabled = true;
    
    try {
        // Submit with email subject and enhanced data
        const emailData = {
            ...formData,
            subject: 'REQUEST OFF APPROVAL',
            supervisorEmail: 'bmillare@tutoringclub.com',
            emailType: 'approval_request'
        };
        
        const success = await submitToGoogleAppsScript(emailData);
        
        if (success) {
            // Show success message
            document.getElementById('timeOffForm').style.display = 'none';
            document.getElementById('successMessage').style.display = 'block';
            document.getElementById('successMessage').scrollIntoView({ behavior: 'smooth' });
        } else {
            throw new Error('Submission failed');
        }
    } catch (error) {
        console.error('Form submission error:', error);
        alert('There was an error submitting your request. Please try again.');
    } finally {
        // Reset loading state
        submitButton.textContent = originalText;
        submitButton.disabled = false;
    }
}

/**
 * Enhanced Google Apps Script integration for email workflow
 */
async function submitToGoogleAppsScript(data) {
    // For now, simulate success - this will be replaced with actual Google Apps Script URL
    console.log('Submitting to Google Apps Script:', data);
    
    // Simulate API call
    return new Promise((resolve) => {
        setTimeout(() => {
            resolve(true);
        }, 1000);
    });
}

/**
 * Export functions for integration with existing code
 */
window.DynamicForm = {
    handleSignatureComplete,
    submitDynamicForm,
    formSections
};