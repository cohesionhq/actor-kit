// The rules cohesiond refuses an image for, applied before a message is
// reported so one bad image costs the image, not the message.

import type { ClientImage } from 'cohesion-ts';

/** The most images one message carries. */
export const MAX_IMAGES = 10;
/** The most one image's base64 may be: 5 MB. */
export const MAX_IMAGE_LENGTH = 5 * 1024 * 1024;
export const MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Whether `data` is standard, padded base64, with nothing around it. */
export function isBase64(data: string): boolean {
	return data.length > 0 && data.length % 4 === 0 && BASE64.test(data);
}

/** Why cohesiond would refuse `image`, or `null` when it wouldn't. */
export function refusal(image: ClientImage): string | null {
	if (!(MEDIA_TYPES as readonly string[]).includes(image.media_type)) return `it is ${image.media_type || 'of no type'}`;
	if (!isBase64(image.data)) return "it isn't base64";
	if (image.data.length > MAX_IMAGE_LENGTH) return 'it is over 5 MB';
	return null;
}

/**
 * `image` tidied the way cohesiond wants it: whitespace, a `data:` prefix
 * and missing padding gone, and `image/jpg` named `image/jpeg`.
 */
export function tidy(image: ClientImage): ClientImage {
	const media_type = image.media_type.trim().toLowerCase().replace(/^image\/jpg$/, 'image/jpeg');
	let data = image.data.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
	if (/^[A-Za-z0-9+/]+$/.test(data) && data.length % 4 > 1) data += '='.repeat(4 - (data.length % 4));
	return { media_type, data };
}

/** What a message can carry of `images`, and what it can't, with why. */
export function sendable(images: ClientImage[]): { images: ClientImage[]; dropped: string[] } {
	const kept: ClientImage[] = [];
	const dropped: string[] = [];
	for (const image of images.map(tidy)) {
		const why = kept.length < MAX_IMAGES ? refusal(image) : `a message carries at most ${MAX_IMAGES}`;
		if (why) dropped.push(why);
		else kept.push(image);
	}
	return { images: kept, dropped };
}
