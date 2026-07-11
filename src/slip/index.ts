import { config } from '../config';
import { ClaudeVisionVerifier } from './claude';
import { EasySlipVerifier } from './easyslip';
import type { SlipVerifier } from './types';

export type { SlipData, SlipVerifier, VerifyOutcome } from './types';

/** Resolve the configured slip-reading adapter. */
export function getVerifier(): SlipVerifier {
  switch (config.SLIP_VENDOR) {
    case 'easyslip':
      return new EasySlipVerifier();
    case 'claude':
    default:
      return new ClaudeVisionVerifier();
  }
}
