import http from 'http';
import crypto from 'crypto';
import express, { type Express } from 'express';
import { logger } from '../logger.js';

export interface AuthServer {
  app: Express;
  server: http.Server;
  waitForCode: () => Promise<string>;
  /** State value that must be appended to the authorization URL. */
  authState: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function failPage(title: string, message: string): string {
  return `
    <!DOCTYPE html>
    <html>
      <head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
      <body>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(message)}</p>
        <p>Please close this tab and check the terminal for details.</p>
      </body>
    </html>
  `;
}

export async function startAuthServer(port: number): Promise<AuthServer> {
  const app = express();

  // State parameter binds the callback to this flow: a crafted callback URL
  // from another host cannot inject its own authorization code. Only the
  // exact state issued by startAuthServer is accepted.
  const state = crypto.randomBytes(16).toString('hex');
  let stateValidated = false;
  let resolveCode: (code: string) => void;
  let rejectCode: (err: Error) => void;

  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  app.get('/callback', (req, res) => {
    const code = req.query['code'];
    const error = req.query['error'];

    if (req.query['state'] !== state) {
      const msg = 'Invalid or missing OAuth state on callback';
      logger.error(msg);
      res
        .status(400)
        .type('html')
        .send(failPage('Authentication Failed', msg));
      rejectCode(new Error(msg));
      return;
    }
    stateValidated = true;

    if (error) {
      const rawDescription =
        typeof req.query['error_description'] === 'string'
          ? req.query['error_description']
          : String(error);
      logger.error(`OAuth error from TrueLayer: ${rawDescription}`);
      res
        .status(400)
        .type('html')
        .send(failPage('Authentication Failed', `Error: ${rawDescription}`));
      rejectCode(new Error(`OAuth error: ${rawDescription}`));
      return;
    }

    if (typeof code !== 'string' || !code) {
      const msg = 'No authorization code received from TrueLayer';
      logger.error(msg);
      res
        .status(400)
        .type('html')
        .send(failPage('Authentication Failed', msg));
      rejectCode(new Error(msg));
      return;
    }

    logger.info('Authorization code received successfully');

    res
      .status(200)
      .type('html')
      .send(`
        <!DOCTYPE html>
        <html>
          <head><meta charset="utf-8"><title>Authentication Successful</title></head>
          <body style="font-family: sans-serif; max-width: 480px; margin: 80px auto; text-align: center;">
            <h2 style="color: #22c55e;">Authentication successful!</h2>
            <p>You can close this tab and return to the terminal to finish setup.</p>
          </body>
        </html>
      `);

    resolveCode(code);
  });

  // Loopback only: the OAuth redirect targets localhost, so there is no
  // reason to accept callbacks (or crafted ones) from other machines.
  const server = await new Promise<http.Server>((resolve, reject) => {
    const s = app.listen(port, '127.0.0.1', () => {
      logger.info(`Auth server listening on http://localhost:${port}`);
      resolve(s);
    });
    s.on('error', (err) => {
      reject(
        new Error(
          `Failed to start auth server on port ${port}: ${err.message}. ` +
            'Try setting a different SETUP_PORT in your .env file.'
        )
      );
    });
  });

  if (!stateValidated) {
    logger.debug('Auth server ready; awaiting callback with the issued state');
  }

  return {
    app,
    server,
    waitForCode: () => codePromise,
    authState: state,
  };
}
