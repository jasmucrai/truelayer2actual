import http from 'http';
import express, { type Express } from 'express';
import { logger } from '../logger.js';

export interface AuthServer {
  app: Express;
  server: http.Server;
  waitForCode: () => Promise<string>;
}

export async function startAuthServer(port: number): Promise<AuthServer> {
  const app = express();

  let resolveCode: (code: string) => void;
  let rejectCode: (err: Error) => void;

  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  app.get('/callback', (req, res) => {
    const code = req.query['code'];
    const error = req.query['error'];

    if (error) {
      const errorDescription =
        (req.query['error_description'] as string | undefined) ?? String(error);
      logger.error(`OAuth error from TrueLayer: ${errorDescription}`);
      res.status(400).send(`
        <!DOCTYPE html>
        <html>
          <head><title>Authentication Failed</title></head>
          <body>
            <h2>Authentication Failed</h2>
            <p>Error: ${String(error)}</p>
            <p>${errorDescription}</p>
            <p>Please close this tab and check the terminal for details.</p>
          </body>
        </html>
      `);
      rejectCode(new Error(`OAuth error: ${errorDescription}`));
      return;
    }

    if (typeof code !== 'string' || !code) {
      const msg = 'No authorization code received from TrueLayer';
      logger.error(msg);
      res.status(400).send(`
        <!DOCTYPE html>
        <html>
          <head><title>Authentication Failed</title></head>
          <body>
            <h2>Authentication Failed</h2>
            <p>${msg}</p>
            <p>Please close this tab and try running setup again.</p>
          </body>
        </html>
      `);
      rejectCode(new Error(msg));
      return;
    }

    logger.info('Authorization code received successfully');

    res.status(200).send(`
      <!DOCTYPE html>
      <html>
        <head><title>Authentication Successful</title></head>
        <body style="font-family: sans-serif; max-width: 480px; margin: 80px auto; text-align: center;">
          <h2 style="color: #22c55e;">Authentication successful!</h2>
          <p>You can close this tab and return to the terminal to finish setup.</p>
        </body>
      </html>
    `);

    resolveCode(code);
  });

  const server = await new Promise<http.Server>((resolve, reject) => {
    const s = app.listen(port, () => {
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

  return {
    app,
    server,
    waitForCode: () => codePromise,
  };
}
