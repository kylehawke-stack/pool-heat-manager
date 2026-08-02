import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
dotenv.config();

export interface PropertyConfig {
  name: string;
  hostawayListingId: number;
  poolSystem: 'screenlogic' | 'intelliconnect';
  // ScreenLogic gateway name (found via Pentair app or discovery)
  screenlogicGateway?: string;
  screenlogicPassword?: string;
  targetTemp: number; // °F
  latitude: number;
  longitude: number;
  checkInHour: number;  // 0-23, local time
  checkOutHour: number; // 0-23, local time
  timezone: string;
}

// Property details (listing IDs, gateway names, coordinates) are private —
// they live in properties.json, which is gitignored. Copy
// properties.example.json to properties.json and fill in your own.
const propertiesPath = path.resolve(process.cwd(), 'properties.json');
if (!fs.existsSync(propertiesPath)) {
  throw new Error(
    'properties.json not found. Copy properties.example.json to properties.json and fill in your property details.'
  );
}

type PropertyFile = Omit<PropertyConfig, 'targetTemp'> & { targetTemp?: number };
const rawProperties: PropertyFile[] = JSON.parse(fs.readFileSync(propertiesPath, 'utf8'));

export const properties: PropertyConfig[] = rawProperties.map((p) => ({
  ...p,
  targetTemp: p.targetTemp ?? (Number(process.env.DEFAULT_TARGET_TEMP) || 85),
}));

export const config = {
  hostaway: {
    clientId: process.env.HOSTAWAY_CLIENT_ID || '',
    clientSecret: process.env.HOSTAWAY_CLIENT_SECRET || '',
    baseUrl: 'https://api.hostaway.com/v1',
  },
  pentair: {
    email: process.env.PENTAIR_EMAIL || '',
    password: process.env.PENTAIR_PASSWORD || '',
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    fromNumber: process.env.TWILIO_FROM_NUMBER || '',
  },
  alerts: {
    phone: process.env.ALERT_PHONE_NUMBER || '',
    email: process.env.ALERT_EMAIL || '',
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY || '',
    fromAddress: process.env.RESEND_FROM_ADDRESS || 'Pool Heat Manager <alerts@poolheat.dev>',
  },
  server: {
    port: Number(process.env.PORT) || 3100,
    webhookLogin: process.env.WEBHOOK_LOGIN || '',
    webhookPassword: process.env.WEBHOOK_PASSWORD || '',
    publicUrl: process.env.PUBLIC_URL || '',
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
  },
};
