

import { DownloadType, VideoQuality, AudioFormat } from './../types/index.js';


export interface DownloadBody {
  url: string;
  type?: DownloadType;
  quality?: VideoQuality; // only for video
  audioFormat?: AudioFormat; // only for audio
}


export interface FormatInfo {
  formatId: string;
  ext: string;
  resolution: string;
  fps: number | null;
  filesize: number | null;
  vcodec: string;
  acodec: string;
  tbr: number | null;
}