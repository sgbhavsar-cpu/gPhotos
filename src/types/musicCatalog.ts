// The built-in, royalty-free music list for the video wizard's Music step. Every track is by Kevin MacLeod
// (incompetech.com) and released under Creative Commons Attribution 4.0 — free to use in videos, including
// monetised ones, as long as the credit below appears. The tracks are NOT bundled (about 8 MB each, 166 MB
// together): a track is downloaded from incompetech.com the first time it is chosen or previewed, then kept.
// Pure data + helpers, shared by the main process (download by id) and the renderer (the list).

export type MusicCategory = 'upbeat' | 'relaxed' | 'emotional' | 'cinematic' | 'playful' | 'acoustic';

export interface MusicTrack {
  id: string;
  title: string;
  category: MusicCategory;
  /** File name on incompetech.com (see musicTrackUrl). */
  file: string;
  durationSec: number;
  sizeBytes: number;
  /** Mood words from the catalogue, shown as tags. */
  feel: string[];
}

export const MUSIC_ARTIST = 'Kevin MacLeod';
export const MUSIC_LICENSE_NAME = 'Creative Commons: By Attribution 4.0';
export const MUSIC_LICENSE_URL = 'https://creativecommons.org/licenses/by/4.0/';
export const MUSIC_BASE_URL = 'https://incompetech.com/music/royalty-free/mp3-royaltyfree';

export const MUSIC_CATEGORY_LABEL: Record<MusicCategory, string> = {
  upbeat: 'Upbeat', relaxed: 'Relaxed', emotional: 'Emotional', cinematic: 'Cinematic', playful: 'Playful', acoustic: 'Acoustic',
};

export const MUSIC_CATALOG: MusicTrack[] = [
  { id: 'carefree', title: "Carefree", category: 'upbeat', file: "Carefree.mp3", durationSec: 205, sizeBytes: 6566713, feel: ["Bouncy","Bright","Calming"] },
  { id: 'wallpaper', title: "Wallpaper", category: 'upbeat', file: "Wallpaper.mp3", durationSec: 220, sizeBytes: 8804339, feel: ["Bouncy","Bright","Calming"] },
  { id: 'life-of-riley', title: "Life of Riley", category: 'upbeat', file: "Life of Riley.mp3", durationSec: 235, sizeBytes: 7533831, feel: ["Bright","Relaxed","Uplifting"] },
  { id: 'happy-bee', title: "Happy Bee", category: 'upbeat', file: "Happy Bee.mp3", durationSec: 302, sizeBytes: 12082281, feel: ["Bouncy","Bright","Uplifting"] },
  { id: 'cipher', title: "Cipher", category: 'upbeat', file: "Cipher2.mp3", durationSec: 231, sizeBytes: 9252699, feel: ["Bright","Grooving","Uplifting"] },
  { id: 'angel-share', title: "Angel Share", category: 'upbeat', file: "Angel Share.mp3", durationSec: 201, sizeBytes: 6419574, feel: ["Bright","Relaxed","Uplifting"] },
  { id: 'easy-lemon', title: "Easy Lemon", category: 'relaxed', file: "Easy Lemon.mp3", durationSec: 126, sizeBytes: 5057420, feel: ["Bright","Calming","Relaxed"] },
  { id: 'bossa-antigua', title: "Bossa Antigua", category: 'relaxed', file: "Bossa Antigua.mp3", durationSec: 283, sizeBytes: 9069455, feel: ["Bright","Grooving","Relaxed"] },
  { id: 'backbay-lounge', title: "Backbay Lounge", category: 'relaxed', file: "Backbay Lounge.mp3", durationSec: 267, sizeBytes: 8531962, feel: ["Bright","Grooving","Relaxed"] },
  { id: 'windswept', title: "Windswept", category: 'relaxed', file: "Windswept.mp3", durationSec: 208, sizeBytes: 8335980, feel: ["Calming","Relaxed"] },
  { id: 'local-forecast-elevator', title: "Local Forecast - Elevator", category: 'relaxed', file: "Local Forecast - Elevator.mp3", durationSec: 189, sizeBytes: 7570404, feel: ["Bouncy","Bright","Grooving"] },
  { id: 'promises-to-keep', title: "Promises to Keep", category: 'emotional', file: "Promises to Keep.mp3", durationSec: 304, sizeBytes: 12164741, feel: ["Calming","Somber","Uplifting"] },
  { id: 'danse-morialta', title: "Danse Morialta", category: 'emotional', file: "Danse Morialta.mp3", durationSec: 236, sizeBytes: 9455316, feel: ["Calming","Relaxed","Somber"] },
  { id: 'rains-will-fall', title: "Rains Will Fall", category: 'emotional', file: "Rains Will Fall.mp3", durationSec: 222, sizeBytes: 8898445, feel: ["Calming","Somber","Uplifting"] },
  { id: 'americana', title: "Americana", category: 'cinematic', file: "Americana.mp3", durationSec: 202, sizeBytes: 8090770, feel: ["Epic","Uplifting"] },
  { id: 'skye-cuillin', title: "Skye Cuillin", category: 'cinematic', file: "Skye Cuillin.mp3", durationSec: 193, sizeBytes: 7861123, feel: ["Calming","Epic","Mystical"] },
  { id: 'call-to-adventure', title: "Call to Adventure", category: 'cinematic', file: "Call to Adventure.mp3", durationSec: 247, sizeBytes: 9894055, feel: ["Action","Bright","Bouncy"] },
  { id: 'monkeys-spinning-monkeys', title: "Monkeys Spinning Monkeys", category: 'playful', file: "Monkeys Spinning Monkeys.mp3", durationSec: 125, sizeBytes: 5005207, feel: ["Bouncy","Bright","Humorous"] },
  { id: 'cattails', title: "Cattails", category: 'acoustic', file: "Cattails.mp3", durationSec: 159, sizeBytes: 6365435, feel: ["Bouncy","Calming","Relaxed"] },
  { id: 'inspired', title: "Inspired", category: 'acoustic', file: "Inspired.mp3", durationSec: 286, sizeBytes: 9156393, feel: ["Bright","Relaxed","Calming"] },
];

export const musicTrackUrl = (t: MusicTrack, base: string = MUSIC_BASE_URL) => `${base.replace(/\/+$/, '')}/${encodeURIComponent(t.file)}`;

export const findMusicTrack = (id: string): MusicTrack | undefined => MUSIC_CATALOG.find((t) => t.id === id);

/** The credit the licence requires — shown on the end-credits screen when one of these tracks is used. */
export const musicCreditText = (t: MusicTrack) =>
  `Music: "${t.title}" by ${MUSIC_ARTIST} (incompetech.com)
Licensed under ${MUSIC_LICENSE_NAME}
${MUSIC_LICENSE_URL}`;
