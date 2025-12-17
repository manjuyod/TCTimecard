# Google Apps Script Project with `clasp`

This project is managed using `clasp`, the command-line tool for Google Apps Script.

## Development Workflow

1.  **Edit Locally**: Make changes to the project files (`.js`, `.html`) in your local IDE.
2.  **Push Changes**: Upload your local changes to the Google Apps Script project using the following command:
    ```bash
    clasp push
    ```
    This will overwrite the code in the online editor with your local files.
3.  **Test Online**: Open the project in the Apps Script editor to test your changes.
    ```bash
    clasp open --url
    ```
    This will provide a URL to open the project in the Apps Script editor. In the editor, you can run functions or access the development version of your web app under `Deploy` > `Test deployments`.
4.  **Create a Version**: Once you're happy with your changes, create a new, immutable version of your script.
    ```bash
    clasp version "Your descriptive version message"
    ```
5.  **Deploy**: Deploy the new version to update your web app or add-on.
    ```bash
    clasp deploy
    ```
