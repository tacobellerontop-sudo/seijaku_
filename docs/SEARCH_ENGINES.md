# Seijaku search engines

Pick one in Settings. The address bar and the home search both use it:
anything typed that isn't an address becomes a search on the chosen
engine. The default is DuckDuckGo.

| Engine | Search URL (`%s` is your search) |
| --- | --- |
| DuckDuckGo (default) | `https://duckduckgo.com/?q=%s` |
| Google | `https://www.google.com/search?q=%s` |
| Bing | `https://www.bing.com/search?q=%s` |
| Brave | `https://search.brave.com/search?q=%s` |
| Startpage | `https://www.startpage.com/sp/search?query=%s` |
| Ecosia | `https://www.ecosia.org/search?q=%s` |
| Mojeek | `https://www.mojeek.com/search?q=%s` |
| Qwant | `https://www.qwant.com/?q=%s` |

## A custom engine

Pick `Custom` in Settings and type any search URL with `%s` where the
search goes. The same URL lives in the `seijaku.searchUrl` pref, so it
can also be set by hand. Two things to get right:

- The URL must contain exactly one `%s`.
- Use the engine's own search URL (open the engine, search once, and
  copy the address with your words replaced by `%s`).

Seijaku sends nothing extra with a search: no account, no history, and
no tracking parameters of its own. What the engine itself records is
the engine's business — DuckDuckGo, Brave, Startpage, Mojeek, and
Qwant are the no-tracking-leaning choices in the list above.
