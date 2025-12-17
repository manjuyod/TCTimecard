/**
 * Time Off Request Form - Main JavaScript File
 * Handles form validation, interactions, and Google Apps Script integration
 */

// Global variables
let employeeSignaturePad;
let managerSignaturePad;
let formData = {};

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    initializeForm();
    initializeSignaturePads();
    bindEventListeners();
    setDefaultDates();
    
    // Override form submission for dynamic functionality
    document.getElementById('timeOffForm').addEventListener('submit', function(event) {
        if (window.DynamicForm && window.DynamicForm.submitDynamicForm) {
            window.DynamicForm.submitDynamicForm(event);
        } else {
            handleFormSubmit(event);
        }
    });
});

/**
 * Initialize form elements and default values
 */
function initializeForm() {
    const form = document.getElementById('timeOffForm');
    const partialDayCheckbox = document.getElementById('partialDay');
    const partialDaySection = document.getElementById('partialDaySection');
    const otherAbsenceInput = document.getElementById('otherAbsenceType');
    const absenceTypeRadios = document.querySelectorAll('input[name="absenceType"]');
    
    // Handle partial day checkbox
    partialDayCheckbox.addEventListener('change', function() {
        if (this.checked) {
            partialDaySection.style.display = 'block';
        } else {
            partialDaySection.style.display = 'none';
            document.getElementById('leaveTime').value = '';
            document.getElementById('returnTime').value = '';
        }
    });
    
    // Handle "other" absence type
    absenceTypeRadios.forEach(radio => {
        radio.addEventListener('change', function() {
            if (this.value === 'other') {
                otherAbsenceInput.disabled = false;
                otherAbsenceInput.required = true;
                otherAbsenceInput.focus();
            } else {
                otherAbsenceInput.disabled = true;
                otherAbsenceInput.required = false;
                otherAbsenceInput.value = '';
            }
        });
    });
}

/**
 * Initialize signature pads
 */
function initializeSignaturePads() {
    // This function is now a placeholder.
    // The initialization is moved to a global function to be called on demand.
}

/**
 * Initialize signature pads on demand
 */
window.initializeSignaturePads = function() {
    if (employeeSignaturePad) {
        return; // Already initialized
    }

    const employeeCanvas = document.getElementById('employeeSignature');
    if (!employeeCanvas) return;

    // Use ResizeObserver to initialize the pad only when the canvas is visible and has a size.
    const observer = new ResizeObserver(entries => {
        const entry = entries[0];
        if (entry.contentRect.width > 0) {
            // Disconnect the observer once we have a size.
            observer.disconnect();

            // Now, initialize the signature pad.
            employeeSignaturePad = new SignaturePad(employeeCanvas, {
                backgroundColor: '#ffffff',
                penColor: '#000000',
                minWidth: 1,
                maxWidth: 3
            });

            // Bind clear button
            const clearEmployeeBtn = document.getElementById('clearEmployeeSignature');
            if (clearEmployeeBtn) {
                clearEmployeeBtn.addEventListener('click', () => employeeSignaturePad.clear());
            }

            // Integrate with dynamic form
            employeeSignaturePad.on('end', () => {
                const submitBtn = document.getElementById('finalSubmitBtn');
                if (submitBtn && !employeeSignaturePad.isEmpty()) {
                    submitBtn.disabled = false;
                }

                if (!employeeSignaturePad.isEmpty() && window.DynamicForm) {
                    const signatureDate = document.getElementById('employeeSignatureDate').value;
                    if (signatureDate) {
                        window.DynamicForm.handleSignatureComplete();
                    }
                }
            });

            const signatureDateInput = document.getElementById('employeeSignatureDate');
            if (signatureDateInput) {
                signatureDateInput.addEventListener('change', () => {
                    if (signatureDateInput.value && employeeSignaturePad && !employeeSignaturePad.isEmpty() && window.DynamicForm) {
                        window.DynamicForm.handleSignatureComplete();
                    }
                });
            }
        }
    });

    observer.observe(employeeCanvas);
};

/**
 * Bind event listeners
 */
function bindEventListeners() {
    const form = document.getElementById('timeOffForm');
    const printButton = document.getElementById('printForm');
    
    // Form submission
    form.addEventListener('submit', handleFormSubmit);
    
    // Print button
    printButton.addEventListener('click', handlePrintForm);
    
    // Real-time validation
    const requiredFields = ['employeeName', 'todaysDate', 'startDate', 'endDate', 'reason', 'employeeSignatureDate'];
    requiredFields.forEach(fieldId => {
        const field = document.getElementById(fieldId);
        if (field) {
            field.addEventListener('blur', () => validateField(fieldId));
            field.addEventListener('input', () => clearError(fieldId));
        }
    });
    
    // Date validation
    document.getElementById('startDate').addEventListener('change', validateDates);
    document.getElementById('endDate').addEventListener('change', validateDates);
    
    // Absence type validation
    document.querySelectorAll('input[name="absenceType"]').forEach(radio => {
        radio.addEventListener('change', () => clearError('absenceType'));
    });
}

/**
 * Set default dates
 */
function setDefaultDates() {
    const today = new Date();
    const todayString = today.toISOString().split('T')[0];
    
    document.getElementById('todaysDate').value = todayString;
    document.getElementById('employeeSignatureDate').value = todayString;
    document.getElementById('startDate').value = todayString;
}

/**
 * Validate individual field
 */
function validateField(fieldId) {
    const field = document.getElementById(fieldId);
    const errorElement = document.getElementById(fieldId + 'Error');
    
    if (!field || !errorElement) return true;
    
    let isValid = true;
    let errorMessage = '';
    
    // Check if field is required and empty
    if (field.required && !field.value.trim()) {
        isValid = false;
        errorMessage = 'This field is required.';
    }
    
    // Additional validation based on field type
    switch (fieldId) {
        case 'employeeName':
            if (field.value.trim().length < 2) {
                isValid = false;
                errorMessage = 'Employee name must be at least 2 characters long.';
            }
            break;
            
        case 'todaysDate':
        case 'employeeSignatureDate':
            if (field.value && !isValidDate(field.value)) {
                isValid = false;
                errorMessage = 'Please enter a valid date.';
            }
            break;
            
        case 'startDate':
        case 'endDate':
            if (field.value && !isValidDate(field.value)) {
                isValid = false;
                errorMessage = 'Please enter a valid date.';
            }
            break;
            
        case 'reason':
            if (field.value.trim().length < 10) {
                isValid = false;
                errorMessage = 'Please provide a more detailed reason (at least 10 characters).';
            }
            break;
    }
    
    // Show/hide error
    if (isValid) {
        clearError(fieldId);
    } else {
        showError(fieldId, errorMessage);
    }
    
    return isValid;
}

/**
 * Validate date range
 */
function validateDates() {
    const startDate = document.getElementById('startDate').value;
    const endDate = document.getElementById('endDate').value;
    const todaysDate = document.getElementById('todaysDate').value;
    
    if (!startDate || !endDate) return true;
    
    const start = new Date(startDate);
    const end = new Date(endDate);
    const today = new Date(todaysDate);
    
    // Check if end date is after start date
    if (end < start) {
        showError('endDate', 'End date must be after start date.');
        return false;
    }
    
    // Check if absence is at least 14 days in advance (except for sick leave)
    const absenceType = document.querySelector('input[name="absenceType"]:checked');
    if (absenceType && absenceType.value !== 'sick') {
        const daysDifference = Math.floor((start - today) / (1000 * 60 * 60 * 24));
        if (daysDifference < 14) {
            showError('startDate', 'Requests for absences (other than sick leave) must be submitted 14 days in advance.');
            return false;
        }
    }
    
    clearError('startDate');
    clearError('endDate');
    return true;
}

/**
 * Validate absence type
 */
function validateAbsenceType() {
    const absenceType = document.querySelector('input[name="absenceType"]:checked');
    const otherAbsenceInput = document.getElementById('otherAbsenceType');
    
    if (!absenceType) {
        showError('absenceType', 'Please select a type of absence.');
        return false;
    }
    
    if (absenceType.value === 'other' && !otherAbsenceInput.value.trim()) {
        showError('absenceType', 'Please specify the type of absence.');
        otherAbsenceInput.focus();
        return false;
    }
    
    clearError('absenceType');
    return true;
}

/**
 * Validate employee signature
 */
function validateEmployeeSignature() {
    if (!employeeSignaturePad || employeeSignaturePad.isEmpty()) {
        showError('employeeSignature', 'Employee signature is required.');
        return false;
    }
    
    clearError('employeeSignature');
    return true;
}

/**
 * Validate entire form
 */
function validateForm() {
    let isValid = true;
    
    // Validate required fields
    const requiredFields = ['employeeName', 'todaysDate', 'startDate', 'endDate', 'reason', 'employeeSignatureDate'];
    requiredFields.forEach(fieldId => {
        if (!validateField(fieldId)) {
            isValid = false;
        }
    });
    
    // Validate dates
    if (!validateDates()) {
        isValid = false;
    }
    
    // Validate absence type
    if (!validateAbsenceType()) {
        isValid = false;
    }
    
    // Validate employee signature
    if (!validateEmployeeSignature()) {
        isValid = false;
    }
    
    return isValid;
}

/**
 * Show error message
 */
function showError(fieldId, message) {
    const errorElement = document.getElementById(fieldId + 'Error');
    const fieldElement = document.getElementById(fieldId);
    
    if (errorElement) {
        errorElement.textContent = message;
        errorElement.classList.add('show');
    }
    
    if (fieldElement) {
        fieldElement.parentElement.classList.add('error');
    }
}

/**
 * Clear error message
 */
function clearError(fieldId) {
    const errorElement = document.getElementById(fieldId + 'Error');
    const fieldElement = document.getElementById(fieldId);
    
    if (errorElement) {
        errorElement.textContent = '';
        errorElement.classList.remove('show');
    }
    
    if (fieldElement) {
        fieldElement.parentElement.classList.remove('error');
    }
}

/**
 * Check if date is valid
 */
function isValidDate(dateString) {
    const date = new Date(dateString);
    return date instanceof Date && !isNaN(date);
}

/**
 * Collect form data
 */
function collectFormData() {
    const form = document.getElementById('timeOffForm');
    const formData = new FormData(form);
    const data = {};
    
    // Collect basic form data
    for (let [key, value] of formData.entries()) {
        data[key] = value;
    }
    
    // Add signature data
    data.employeeSignatureData = (!employeeSignaturePad || employeeSignaturePad.isEmpty()) ? null : employeeSignaturePad.toDataURL();
    data.managerSignatureData = null; // Manager signature pad is not used
    
    // Add calculated fields
    data.totalDays = calculateTotalDays(data.startDate, data.endDate);
    data.submissionTimestamp = new Date().toISOString();
    
    // Handle partial day times
    if (data.partialDay) {
        data.leaveTime = document.getElementById('leaveTime').value;
        data.returnTime = document.getElementById('returnTime').value;
    }
    
    return data;
}

/**
 * Calculate total days between two dates
 */
function calculateTotalDays(startDate, endDate) {
    if (!startDate || !endDate) return 0;
    
    const start = new Date(startDate);
    const end = new Date(endDate);
    const timeDiff = end.getTime() - start.getTime();
    const daysDiff = Math.ceil(timeDiff / (1000 * 3600 * 24)) + 1; // Include both start and end days
    
    return daysDiff;
}

/**
 * Handle form submission
 */
async function handleFormSubmit(event) {
    event.preventDefault();
    
    // Validate form
    if (!validateForm()) {
        alert('Please correct the errors in the form before submitting.');
        return;
    }
    
    // Collect form data
    const data = collectFormData();
    
    // Show loading state
    const form = document.getElementById('timeOffForm');
    const submitButton = form.querySelector('button[type="submit"]');
    const originalText = submitButton.textContent;
    
    form.classList.add('form-loading');
    submitButton.textContent = 'Submitting...';
    submitButton.disabled = true;
    
    try {
        // Submit to Google Apps Script
        const success = await submitToGoogleAppsScript(data);
        
        if (success) {
            // Show success message
            document.getElementById('timeOffForm').style.display = 'none';
            document.getElementById('successMessage').style.display = 'block';
            
            // Scroll to success message
            document.getElementById('successMessage').scrollIntoView({ behavior: 'smooth' });
        } else {
            throw new Error('Submission failed');
        }
    } catch (error) {
        console.error('Form submission error:', error);
        alert('There was an error submitting your request. Please try again.');
    } finally {
        // Reset loading state
        form.classList.remove('form-loading');
        submitButton.textContent = originalText;
        submitButton.disabled = false;
    }
}

/**
 * Submit data to Google Apps Script
 * This function is designed to work with Google Apps Script web apps
 */
async function submitToGoogleAppsScript(data) {
    try {
        // Get the Google Apps Script web app URL from environment or use default
        const scriptUrl = window.GOOGLE_SCRIPT_URL || 'YOUR_GOOGLE_APPS_SCRIPT_URL_HERE';
        
        if (scriptUrl === 'YOUR_GOOGLE_APPS_SCRIPT_URL_HERE') {
            // For development/testing - log data to console
            console.log('Form Data to be submitted:', data);
            
            // Simulate successful submission
            return new Promise((resolve) => {
                setTimeout(() => {
                    resolve(true);
                }, 1000);
            });
        }
        
        // Submit to Google Apps Script
        const response = await fetch(scriptUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
            mode: 'cors'
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const result = await response.json();
        return result.success === true;
        
    } catch (error) {
        console.error('Google Apps Script submission error:', error);
        return false;
    }
}

/**
 * Handle print form
 */
function handlePrintForm() {
    // Validate form before printing
    if (!validateForm()) {
        alert('Please complete all required fields before printing.');
        return;
    }
    
    // Trigger print
    window.print();
}

/**
 * Google Apps Script integration helper functions
 */
window.timeOffFormUtils = {
    /**
     * Set Google Apps Script URL
     */
    setScriptUrl: function(url) {
        window.GOOGLE_SCRIPT_URL = url;
    },
    
    /**
     * Get current form data
     */
    getFormData: function() {
        return collectFormData();
    },
    
    /**
     * Set form data (for pre-filling)
     */
    setFormData: function(data) {
        Object.keys(data).forEach(key => {
            const element = document.getElementById(key);
            if (element) {
                if (element.type === 'radio') {
                    const radio = document.querySelector(`input[name="${key}"][value="${data[key]}"]`);
                    if (radio) radio.checked = true;
                } else if (element.type === 'checkbox') {
                    element.checked = data[key];
                } else {
                    element.value = data[key];
                }
            }
        });
        
        // Handle signatures
        if (data.employeeSignatureData) {
            employeeSignaturePad.fromDataURL(data.employeeSignatureData);
        }
        if (data.managerSignatureData) {
            managerSignaturePad.fromDataURL(data.managerSignatureData);
        }
    },
    
    /**
     * Clear form
     */
    clearForm: function() {
        document.getElementById('timeOffForm').reset();
        employeeSignaturePad.clear();
        managerSignaturePad.clear();
        setDefaultDates();
    },
    
    /**
     * Validate current form
     */
    validateForm: function() {
        return validateForm();
    }
};

/**
 * Export functions for Google Apps Script integration
 */
if (typeof google !== 'undefined' && google.script) {
    // Running in Google Apps Script environment
    window.google.script.run
        .withSuccessHandler(function(result) {
            console.log('Google Apps Script success:', result);
        })
        .withFailureHandler(function(error) {
            console.error('Google Apps Script error:', error);
        });
}
