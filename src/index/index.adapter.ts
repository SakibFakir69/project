


import { BaseAdapter } from "../adapter/ Base.adapter.js";
import { FacebookAdapter } from "../adapter/Facebook.adapter.js";
import { GenericAdapter } from "../adapter/Generic.adapter.js";
import { InstagramAdapter } from "../adapter/Instagram.adapter.js";
import { TikTokAdapter } from "../adapter/Tiktok.adapter.js";
import { YouTubeAdapter } from "../adapter/Youtube.adapter.js";




const registry = new Map<string, BaseAdapter>([
  ["youtube",   new YouTubeAdapter()],
  ["tiktok",    new TikTokAdapter()],
  ["instagram", new InstagramAdapter()],
  ["facebook",  new FacebookAdapter()],
  ["generic",   new GenericAdapter()],
]);

const generic = new GenericAdapter();

export function getAdapter(platform: string): BaseAdapter {
  return registry.get(platform) ?? generic;
}