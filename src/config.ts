import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { logger } from './logger.js';

const AccountSchema = z.object({
  name: z.string(),
  connectionId: z.string(),
  accountKind: z.enum(['account', 'card']).default('account'),
  truelayerAccountId: z.string(),
  actualAccountId: z.string(),
  currency: z.string().default('GBP'),
  lastSyncedAt: z.string().optional(),
});

const ConfigSchema = z.object({
  accounts: z.array(AccountSchema),
  createdAt: z.string(),
});

export type Account = z.infer<typeof AccountSchema>;
export type Config = z.infer<typeof ConfigSchema>;

const CONFIG_PATH = path.join(process.cwd(), 'data', 'config.json');

export async function loadConfig(): Promise<Config> {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `Config file not found at ${CONFIG_PATH}. ` +
        'Please run "npm run setup" first to create an account mapping.'
    );
  }

  let raw: unknown;
  try {
    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    raw = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `Failed to read or parse config file at ${CONFIG_PATH}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid config file at ${CONFIG_PATH}: ${result.error.message}`
    );
  }

  logger.debug(`Loaded config with ${result.data.accounts.length} account(s)`);
  return result.data;
}

export async function saveConfig(config: Config): Promise<void> {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const result = ConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Cannot save invalid config: ${result.error.message}`);
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(result.data, null, 2) + '\n', {
    encoding: 'utf-8',
  });
  logger.debug(`Saved config to ${CONFIG_PATH}`);
}
