# Time Card App

## Overview
A Vite + React (TypeScript) client and Express (TypeScript) API for tutoring franchises to track tutoring hours, submit extra hours, request time off, and process approvals. UI is Tailwind + shadcn/ui with FullCalendar.

## Project Structure
- `client/` - Vite React app (TSX) with React Router, Tailwind, shadcn/ui, FullCalendar
- `server/` - Express API in TypeScript
- `LegacyFormForStyle/` - legacy assets for branding tokens

## Development
Run `npm run dev` to start both client (Vite on port 5000) and server (Express on port 3000) concurrently.

The Vite dev server proxies `/api` requests to the Express backend.

## Database Requirements
This app requires two database connections:
- **PostgreSQL**: For payroll settings, extra hours, and time off requests
- **MSSQL**: For tutor/franchise identity and tutoring schedule data

### Required Environment Variables/Secrets
Set these in Replit Secrets for the app to function fully:

**PostgreSQL (required)**:
- `POSTGRES_URL` or `DATABASE_URL` - full connection string

**MSSQL (required)**:
- `MSSQL_SERVER`, `MSSQL_DATABASE`, `MSSQL_USER`, `MSSQL_PASSWORD`

**Session**:
- `SESSION_SECRET` - session signing secret (required for production)

**Optional**:
- `SKIP_DB_VALIDATION=true` - skip database validation for development

## Recent Changes (Dec 2025)
- Configured for Replit environment
- Vite server set to host 0.0.0.0:5000 with all hosts allowed
- Express server runs on port 3000
- Added SKIP_DB_VALIDATION option for development without databases
- Deployment configured for autoscale with build and start commands

## User Preferences
- None recorded yet
