// Clipping masks (v3, R11): an attachment with `clip` is cut to another attachment's
// drawn shape (src/render/draw.ts). One level only: a mask is not itself clipped, and an
// FX socket (draws nothing) can be neither.
import type { Attachment } from './types.ts';

/** Problems with clipping `att` to the attachment with id `maskId` (empty when valid). */
export function clipProblems(attachments: readonly Attachment[], att: Attachment, maskId: string): string[] {
  const mask = attachments.find((a) => a.id === maskId);
  if (!mask) return [`references missing attachment "${maskId}"`];
  const out: string[] = [];
  if (mask.id === att.id) out.push('an attachment cannot clip itself');
  if (mask.clip) out.push(`“${mask.name}” is itself clipped; masks are one level deep`);
  if (attachments.some((a) => a.clip === att.id)) out.push(`“${att.name}” is a mask for another attachment; masks are one level deep`);
  if (mask.emitter || att.emitter) out.push('an emitter cannot be a mask or be clipped');
  return out;
}

/** Sets (or with null clears) an attachment's mask; returns the problems instead when invalid. */
export function setClip(attachments: Attachment[], attId: string, maskId: string | null): string[] {
  const att = attachments.find((a) => a.id === attId);
  if (!att) return [`no attachment "${attId}"`];
  if (maskId === null) {
    delete att.clip;
    return [];
  }
  const bad = clipProblems(attachments, att, maskId);
  if (!bad.length) att.clip = maskId;
  return bad;
}
