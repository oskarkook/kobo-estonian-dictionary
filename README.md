# Estonian Kobo dictionary (eestikeelne Kobo sõnastik)

Tools for building an Estonian e-reader dictionary from the [Ekilex](https://ekilex.ee/) `eki` dataset, in two formats:

- **Kobo** (`dicthtml-et.zip`) - the native Kobo custom dictionary format.
- **StarDict** (`stardict-et.zip`) - for [KOReader](https://koreader.rocks/), as well as other StarDict readers such as sdcv and GoldenDict.

## Install prebuilt dictionary on a Kobo

1. Download `dicthtml-et.zip` [from the latest release](https://github.com/oskarkook/kobo-estonian-dictionary/releases).
2. Plug the device into the computer.
3. Copy `dicthtml-et.zip` to `<KOBO>/.kobo/custom-dict/dicthtml-et.zip`.
4. Eject. On the device: **Settings -> Language and dictionaries -> Dictionaries** and enable "eesti (Custom)".
5. In a book, long-press an Estonian word, then select "eesti (Custom)" as the dictionary from the dropdown.

## Install prebuilt dictionary in KOReader

1. Download `stardict-et.zip` [from the latest release](https://github.com/oskarkook/kobo-estonian-dictionary/releases).
2. Extract it into `koreader/data/dict/` on the device.
3. In KOReader, open a book and long-press an Estonian word. The "eki-et" dictionary
   appears in the lookup popup.

## Building from source

**Prerequisites:**

- [Bun](https://bun.sh/) 1.3+.
- An Ekilex API key - get one from [Ekilex](https://ekilex.ee).
- `dictgen` - download from [pgaskin/dictutil](https://github.com/pgaskin/dictutil/releases) (only needed for the Kobo build).
- `zip`

**Build the dictionaries:**

```sh
# Scrape Ekilex (requires ~7.5GB of space)
EKILEX_API_KEY="<key>" bun run scrape-ekilex.ts
# Build the Kobo dictionary -> dicthtml-et.zip
bun run build.ts
# Build the StarDict dictionary (KOReader) -> stardict-et.zip
bun run build-stardict.ts
```

Both builds read the scraped data from `~/.cache/kobo-estonian-dictionary/` and write
their final artifacts (`dicthtml-et.zip` / `stardict-et.zip`) into the same folder.
