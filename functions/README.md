# Cloud Functions (ScanTrack)

This folder contains server-side attendance validation logic.

## Functions

- `issueTvToken`: Admin-only callable function that generates a short-lived token for the TV screen.
- `recordAttendance`: Authenticated callable function to validate token and store attendance.

## Deploy

1. Install dependencies:
   - `cd functions`
   - `npm install`
2. Deploy:
   - `firebase deploy --only functions`

## Required Auth Claims

Set custom claim `role: "admin"` for admin users.
