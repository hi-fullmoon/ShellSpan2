declare module 'word-extractor' {
  class WordExtractor {
    extract(source: string | Buffer): Promise<{
      getBody(options?: { filterUnicode?: boolean }): string;
    }>;
  }
  export = WordExtractor;
}
