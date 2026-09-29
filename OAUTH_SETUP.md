# Optional OAuth setup — BUEELD historical baseline

This guide originated with the 28 September prototype. OAuth connector code was copied into the 29 September Crusoe edition, but Google and Notion authorization has not been configured or verified for general visitors in this edition. Treat these steps as an optional future setup guide, not a claim that the connectors are live.

The inherited Sources UI contains separate read-only connection paths for Gmail, Google Drive, Google Calendar, and Notion. If configured, each visitor signs in to a Lab account, then authorizes their own provider account. Lab sign-in is kept for 30 days through an HttpOnly, SameSite=Lax cookie and a private authentication store, including across server restarts. Provider tokens stay only in server memory and expire within one hour for Google or two hours for Notion; the browser never receives them. Restarting the process clears those provider connections while preserving Lab sign-in. **Disconnect** clears the local token; a user can also revoke the upstream grant in the provider account settings.

## Required server configuration

Set these only in the server process environment or a secret manager, never in client JavaScript, Git, or a public URL:

- `LAB_PUBLIC_ORIGIN`: exact HTTPS origin used by visitors, for example `https://lab.example.org`. A stable origin is required. `http://localhost:4173` is accepted for local development.
- `LAB_GOOGLE_CLIENT_ID`, `LAB_GOOGLE_CLIENT_SECRET`: an OAuth Web application client from Google Cloud.
- `LAB_NOTION_CLIENT_ID`, `LAB_NOTION_CLIENT_SECRET`: a public Notion connection's credentials.

The server advertises a connector as unconfigured until its credentials and `LAB_PUBLIC_ORIGIN` are present. Its status endpoint is `GET /api/connectors/status`.

## Register these exact callbacks

- Google: `${LAB_PUBLIC_ORIGIN}/api/connectors/google/callback`
- Notion: `${LAB_PUBLIC_ORIGIN}/api/connectors/notion/callback`

Do not register a changing Cloudflare Quick Tunnel hostname as a long-term OAuth origin. Google requires an exact redirect URI match, and Notion requires the configured connection redirect URI. Use a stable hosted origin for multi-tester OAuth.

## Google Cloud

1. Enable Gmail API, Google Drive API, and Google Calendar API on the Google Cloud project that owns the OAuth client.
2. Configure the OAuth consent screen. Bueeld Lab requests permissions when the visitor chooses each connector, not all at once:
   - Gmail: `https://www.googleapis.com/auth/gmail.readonly`
   - Drive: `https://www.googleapis.com/auth/drive.readonly`
   - Calendar: `https://www.googleapis.com/auth/calendar.events.readonly`
3. Create an OAuth Web application client, register the Google callback above, and place its client ID and secret in the server environment. During consent-screen testing, add each intended tester to the Google test-user list. Broader Gmail access can require Google verification before arbitrary users can authorize it.
4. Start the server at the configured origin and choose **Connect** on each desired source card. The Google flow uses OAuth state and PKCE; an access token is kept in memory until its one-hour expiry, sign-out, or a server restart.

## Notion

1. Create a **public connection** in Notion's Developer Portal with read-content capability and the Notion callback above.
2. Put its client ID and client secret in the server environment. Publish/configure the connection according to Notion's installation settings so testers can select their own workspace pages.
3. Each tester chooses the pages to share in Notion's consent screen. The app can list only pages shared with that connection. The demo reads page text through Notion's API; it does not edit pages.

## Data flow and limits

- **List** returns a limited set of recent names and metadata from the connected provider. **Analyze** retrieves only the one to four items the visitor selected, clips each text excerpt, and sends those excerpts to `/api/sources/analyze`, which now uses Crusoe server-side. The raw provider payload is not persisted by this server.
- Drive imports Google Docs as plain text, Sheets as CSV, uploaded text/Markdown/CSV/JSON, and PDFs up to 2 MB with selectable text. Selected Drive PDFs pass through the founder's browser for local text extraction; raw PDF bytes are not sent to Crusoe or saved by the Lab server. Other Drive formats can be downloaded and attached through the local file picker. Notion reads up to 40 blocks of a selected page, including a bounded set of nested blocks. Calendar reads events from the primary calendar in a limited time window.
- This in-memory OAuth token store is suitable only for a temporary, single-process demo. A persistent production connector would need protected token storage, refresh/revocation handling, and a stable HTTPS deployment.

Provider references: [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Notion public-connection authorization](https://developers.notion.com/guides/get-started/authorization).
