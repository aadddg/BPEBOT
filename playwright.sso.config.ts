import { defineConfig } from '@playwright/test';
import base from './playwright.config';
process.env.BPEBOT_UI_SSO = '1';
export default defineConfig({ ...base, testMatch: 'sso-browser.spec.ts' });
