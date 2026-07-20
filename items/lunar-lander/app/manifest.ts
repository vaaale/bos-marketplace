import type { AppManifest } from "@/os/types";

const manifest: AppManifest = {
  id: "lunar-lander",
  name: "Lunar Lander",
  icon: "Rocket",
  defaultWidth: 900,
  defaultHeight: 680,
  order: 90,
  singleton: true,
  builtin: true,
};

export default manifest;
