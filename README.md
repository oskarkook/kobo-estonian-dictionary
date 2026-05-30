# Estonian Kobo dictionary (Eestikeelne Kobo sõnastik)

Tools for building a Kobo e-reader dictionary from the [Ekilex](https://ekilex.ee/) (Estonian Language Institute lexical database) `eki` dataset.

## Install prebuilt dictionary on a Kobo

1. Download `dicthtml-et.zip` [from the latest release](https://github.com/oskarkook/kobo-estonian-dictionary/releases).
2. Plug the device into the computer.
3. Copy `dicthtml-et.zip` to `<KOBO>/.kobo/custom-dict/dicthtml-et.zip`.
4. Eject. On the device: **Settings -> Language and dictionaries -> Dictionaries** and enable "eesti (Custom)".
5. In a book, long-press an Estonian word, then select "eesti (Custom)" as the dictionary from the dropdown.

## Building from source

**Prerequisites:**

- [Bun](https://bun.sh/) 1.3+.
- An Ekilex API key. Get one from the [Ekilex](https://ekilex.ee).
- `dictgen` - download from [pgaskin/dictutil](https://github.com/pgaskin/dictutil/releases).
- `zip`

**Build the dictionary:**

```sh
# Scrape Ekilex (requires ~7.5GB of space)
EKILEX_API_KEY="<key>" bun run scrape-ekilex.ts
# Build the dictionary
bun run build.ts
```

Artifacts are written under `~/.cache/kobo-estonian-dictionary/`. The final dictionary file will be saved in this folder as `dicthtml-et.zip`.
