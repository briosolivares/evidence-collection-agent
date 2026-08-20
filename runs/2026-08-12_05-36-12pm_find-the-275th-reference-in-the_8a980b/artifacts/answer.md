# Task
Find the 275th reference in the References section of the Wikipedia "World War II" page, follow its link to the highlighted entry in the Sources section, and return the full text of that source.

# Findings

The 275th footnote marker in the article text is the superscript "[275]", which appears in the "End of the war in Europe" section of the article, attached to the sentence about besieged Japanese troops at Myitkyina. That footnote links to citation `cite_note-278` in the References list, which reads:

> ^ Beevor 2012, pp. 555–560.

The "Beevor 2012" short citation links to the highlighted, full bibliographic entry in the "Sources" section of the article (anchor `CITEREFBeevor2012`). Its full text is:

**Beevor, Antony (2012). *The Second World War*. London: Weidenfeld & Nicolson. ISBN 978-0-297-84497-6.**

(This entry is the second of two consecutive Beevor entries in the Sources list; the "———" in the entry stands in for the repeated author name "Beevor, Antony", following the immediately preceding entry for Beevor's 1998 book *Stalingrad*.)

# Evidence
- artifacts/ref275_source_highlighted.png — screenshot of the World War II Wikipedia page after navigating to the `#CITEREFBeevor2012` anchor, showing the highlighted Sources entry.
