// TypeScript's DOM types are missing FontFaceSet.add()
declare global {
  interface FontFaceSet {
    add(font: FontFace): void;
  }
}

export type FontManifest = {
  [name: string]: string;
};

function getFontConfigFromManifestName(name: string): {
  family: string;
  descriptors: FontFaceDescriptors;
} {
  switch (name) {
    case "youngSerifRegular":
      return {
        family: "Young Serif",
        descriptors: { style: "normal", weight: "400" },
      };
    case "spectralLight":
      return {
        family: "Spectral",
        descriptors: { style: "normal", weight: "300" },
      };
    case "spectralRegular":
      return {
        family: "Spectral",
        descriptors: { style: "normal", weight: "400" },
      };
    case "spectralSemiBold":
      return {
        family: "Spectral",
        descriptors: { style: "normal", weight: "600" },
      };
    case "tangerineRegular":
      return {
        family: "Tangerine",
        descriptors: { style: "normal", weight: "400" },
      };
    case "tangerineBold":
      return {
        family: "Tangerine",
        descriptors: { style: "normal", weight: "700" },
      };
    default:
      return {
        family: name,
        descriptors: { style: "normal", weight: "400" },
      };
  }
}

export async function registerManifestFonts(
  manifest: FontManifest,
  onFontLoaded?: () => void,
): Promise<void> {
  await Promise.all(
    Object.entries(manifest).map(async ([name, src]) => {
      const { family, descriptors } = getFontConfigFromManifestName(name);
      const fontFace = new FontFace(family, `url(${src})`, descriptors);
      document.fonts.add(await fontFace.load());
      onFontLoaded?.();
    }),
  );
}
