import { describe, expect, it } from 'vitest';

import {
  fetchWikipediaReference,
  htmlToText,
  parseReferenceSourceHtml,
} from './wikipediaClient.js';

const HTML = `
  <p>Text<sup id="cite&#95;ref-278" class="reference"><a href="#cite_note-278"><span class="cite-bracket">&#91;</span>275<span class="cite-bracket">&#93;</span></a></sup></p>
  <ol><li id="cite&#95;note-278"><span class="mw-cite-backlink">^</span> <span class="reference-text"><a href="#CITEREFBeevor2012">Beevor 2012</a>, pp.&#160;555–560.</span></li></ol>
  <ul><li><cite id="CITEREFBeevor2012" class="citation book cs1">Beevor, Antony (2012). <i>The Second World War</i>. London: Weidenfeld &amp; Nicolson. ISBN&#160;978-0-297-84497-6.</cite></li></ul>`;

describe('Wikipedia reference oracle', () => {
  it('follows displayed reference 275 to its Sources citation', () => {
    expect(parseReferenceSourceHtml(HTML)).toEqual({
      pageTitle: 'World War II',
      referenceNumber: 275,
      referenceId: 'cite_note-278',
      referenceText: 'Beevor 2012 , pp. 555–560.',
      sourceId: 'CITEREFBeevor2012',
      sourceText:
        'Beevor, Antony (2012). The Second World War . London: Weidenfeld & Nicolson. ISBN 978-0-297-84497-6.',
    });
  });

  it('decodes numeric and named entities while preserving text', () => {
    expect(htmlToText('<b>A&amp;B</b>&#160;&#x2014; C')).toBe('A&B — C');
  });

  it('throws when the displayed reference or Sources link is absent', () => {
    expect(() => parseReferenceSourceHtml('<p>nothing</p>')).toThrow(/reference \[275\]/);
    expect(() =>
      parseReferenceSourceHtml(HTML.replace('#CITEREFBeevor2012', '#not-a-source')),
    ).toThrow(/does not link/);
  });

  it('fetches through the official parse API and validates its envelope', async () => {
    const seen: string[] = [];
    const fetchFn = async (input: string | URL | Request): Promise<Response> => {
      seen.push(String(input));
      return new Response(JSON.stringify({ parse: { title: 'World War II', text: HTML } }), {
        status: 200,
      });
    };
    const result = await fetchWikipediaReference({
      fetchFn,
      sleep: async () => undefined,
      random: () => 0.5,
    });
    expect(result.sourceId).toBe('CITEREFBeevor2012');
    expect(seen[0]).toContain('action=parse');

    await expect(
      fetchWikipediaReference({
        fetchFn: async () => new Response('{}'),
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(/malformed/);
  });
});
