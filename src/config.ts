import dotenv from 'dotenv';
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

export const properties: PropertyConfig[] = [
  {
    name: 'Marshall House',
    hostawayListingId: 111111,
    poolSystem: 'screenlogic',
    screenlogicGateway: 'Pentair: XX-XX-XX',
    targetTemp: Number(process.env.DEFAULT_TARGET_TEMP) || 85,
    latitude: 38.0,
    longitude: -78.0,
    checkInHour: 15,
    checkOutHour: 10,
    timezone: 'America/New_York',
  },
  {
    name: 'Elmwood',
    hostawayListingId: 222222,
    poolSystem: 'screenlogic',
    screenlogicGateway: 'Pentair: XX-XX-XX',
    targetTemp: Number(process.env.DEFAULT_TARGET_TEMP) || 85,
    latitude: 37.7,
    longitude: -79.0,
    checkInHour: 16,
    checkOutHour: 11,
    timezone: 'America/New_York',
  },
  {
    // TODO: Brady to confirm which property has IntelliConnect
    name: 'Boho Mountain',
    hostawayListingId: 333333,
    poolSystem: 'intelliconnect',
    targetTemp: Number(process.env.DEFAULT_TARGET_TEMP) || 85,
    latitude: 37.7,
    longitude: -79.0,
    checkInHour: 15,
    checkOutHour: 10,
    timezone: 'America/New_York',
  },
];

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
    webhookSecret: process.env.WEBHOOK_SECRET || '',
  },
};
