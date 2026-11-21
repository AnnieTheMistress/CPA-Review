#!/usr/bin/env python3
"""Generate offline fund review pages from the two Markdown study outlines.

Usage: python scripts/generate_fund_reviews.py [--source-dir PATH]
Defaults to the author's artifacts directory; output is always the site's review folder.
Only the Markdown features used by these outlines are supported.
"""
import argparse
import html
from pathlib import Path
import re
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = Path.home() / 'Downloads/Work/学习/artifacts'
PREFIX = 'D:/study/CPA-Study/'
GITHUB = 'https://github.com/AnnieTheMistress/CPA-Study/blob/main/'
LINK = re.compile(r'\[([^\]]+)\]\(<([^>]+)>\)')


def inline(text):
    # Extract links before escaping; quote each URL path while preserving line anchors.
    parts = []
    last = 0
    for match in LINK.finditer(text):
        parts.append(format_text(text[last:match.start()]))
        path = match.group(2)
        if path.startswith(PREFIX):
            source, separator, fragment = path[len(PREFIX):].partition('#')
            path = GITHUB + quote(source, safe='/') + ('?plain=1#' + quote(fragment) if separator else '')
        if not path.startswith(('https://', 'http://', '#')):
            raise ValueError(f'Unsupported link: {path}')
        parts.append(f'<a href="{html.escape(path, quote=True)}">{format_text(match.group(1))}</a>')
        last = match.end()
    parts.append(format_text(text[last:]))
    return ''.join(parts)


def format_text(text):
    text = html.escape(text)
    text = re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
    return re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)


def cells(line):
    return [c.strip() for c in line.strip().strip('|').split('|')]


def render(markdown):
    lines = markdown.splitlines()
    out, headings = [], []
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        if line.startswith('```'):
            i += 1
            code = []
            while i < len(lines) and not lines[i].startswith('```'):
                code.append(lines[i]); i += 1
            if i == len(lines):
                raise ValueError('Unclosed code fence')
            out.append('<pre class="mindmap"><code>' + html.escape('\n'.join(code)) + '</code></pre>')
            i += 1; continue
        heading = re.match(r'^(#{1,6})\s+(.+)$', line)
        if heading:
            level, text = len(heading.group(1)), heading.group(2)
            ident = f'section-{len(headings) + 1}'
            headings.append((level, text, ident))
            out.append(f'<h{level} id="{ident}">{inline(text)}</h{level}>')
            i += 1; continue
        if line.strip() in ('<details>', '</details>'):
            out.append(line.strip()); i += 1; continue
        summary = re.fullmatch(r'\s*<summary>(.*?)</summary>\s*', line)
        if summary:
            out.append('<summary>' + inline(summary.group(1)) + '</summary>'); i += 1; continue
        if line.startswith('|') and i + 1 < len(lines) and re.fullmatch(r'\|[\s:|\-]+\|\s*', lines[i+1]):
            header = cells(line)
            out.append('<div class="table-scroll" tabindex="0" role="region" aria-label="可横向滚动的表格"><table><thead><tr>' + ''.join('<th scope="col">' + inline(c) + '</th>' for c in header) + '</tr></thead><tbody>')
            i += 2
            while i < len(lines) and lines[i].startswith('|'):
                row = cells(lines[i])
                if len(row) != len(header):
                    raise ValueError(f'Table column mismatch at line {i+1}')
                out.append('<tr>' + ''.join('<td>' + inline(c) + '</td>' for c in row) + '</tr>'); i += 1
            out.append('</tbody></table></div>'); continue
        if line.startswith('>'):
            quote_lines = []
            while i < len(lines) and lines[i].startswith('>'):
                quote_lines.append(lines[i][1:].strip()); i += 1
            out.append('<blockquote>' + ''.join('<p>' + inline(x) + '</p>' for x in quote_lines if x) + '</blockquote>'); continue
        item = re.match(r'^(- |\d+\. )(.*)$', line)
        if item:
            ordered = item.group(1) != '- '
            pattern = r'^\d+\. (.*)$' if ordered else r'^- (.*)$'
            tag = 'ol' if ordered else 'ul'
            out.append(f'<{tag}>')
            while i < len(lines):
                m = re.match(pattern, lines[i])
                if not m: break
                out.append('<li>' + inline(m.group(1)) + '</li>'); i += 1
            out.append(f'</{tag}>'); continue
        para = [line]
        i += 1
        while i < len(lines) and lines[i].strip() and not re.match(r'^(?:#{1,6} |```|<details>|</details>|<summary>|\||>|- |\d+\. )', lines[i]):
            para.append(lines[i]); i += 1
        out.append('<p>' + '<br>'.join(inline(x.rstrip()) for x in para) + '</p>')
    return '\n'.join(out), headings


STYLE = '''
:root{color-scheme:light;--ink:#292442;--muted:#675f7b;--accent:#6849a5;--line:#e7e0ee}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#f7f5fa;color:var(--ink);font:16px/1.8 system-ui,-apple-system,"Microsoft YaHei",sans-serif;overflow-wrap:anywhere}a{color:#604396;text-decoration-thickness:1px;text-underline-offset:3px}a:focus-visible,summary:focus-visible{outline:3px solid #b69ce1;outline-offset:3px}header{background:#fff;border-bottom:1px solid var(--line)}.top{max-width:1050px;margin:auto;padding:18px 24px;display:flex;justify-content:space-between;gap:12px;align-items:center}.top a{font-weight:700}.top span{color:var(--muted);font-size:.9rem}main{max-width:1050px;margin:auto;padding:24px}article,.toc{background:#fff;border:1px solid var(--line);border-radius:18px;padding:clamp(18px,4vw,40px);box-shadow:0 6px 24px #39255b0a}.toc{margin-bottom:20px;padding:18px 24px}.toc strong{display:block}.toc a{display:inline-block;margin:4px 14px 4px 0;font-size:.9rem}h1,h2,h3,h4{line-height:1.4;scroll-margin-top:1em}h1{font-size:clamp(1.6rem,4vw,2.4rem);margin-top:0}h2{font-size:1.4rem;border-bottom:1px solid var(--line);padding-bottom:.4em;margin-top:2.4em}h3{margin-top:2em}h4{margin:1.9em 0 .6em;color:#51357f}p{margin:.8em 0}blockquote{margin:1.2em 0;background:#f4f0fa;border-left:4px solid #a88acc;padding:6px 18px;color:#514763}details{background:#faf8fd;border:1px solid var(--line);border-radius:12px;margin:1em 0;padding:12px 16px}summary{cursor:pointer;color:var(--accent);font-weight:700}details[open] summary{border-bottom:1px solid var(--line);padding-bottom:10px}.table-scroll{overflow-x:auto;overscroll-behavior-x:contain;margin:1em 0;border:1px solid var(--line);border-radius:10px}table{border-collapse:collapse;min-width:620px;width:100%;font-size:.93rem}th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{background:#f4f0fa}tr:last-child td{border-bottom:0}.mindmap{overflow-x:auto;background:#29243a;color:#f5efff;border-radius:12px;padding:20px;font:14px/1.7 ui-monospace,Consolas,monospace;white-space:pre}code{font-family:ui-monospace,Consolas,monospace}li{margin:.35em 0}@media(max-width:600px){main{padding:14px}.top{padding:14px 16px}.top span{display:none}article{padding:20px 16px}.toc{padding:16px}.mindmap{font-size:13px;padding:14px}h2{font-size:1.22rem}}
'''


def page(source):
    body, headings = render(source)
    title = headings[0][1]
    toc = ''.join(f'<a href="#{ident}">{inline(text)}</a>' for level, text, ident in headings if level == 2)
    return f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f7f5fa"><title>{html.escape(title)}</title><style>{STYLE}</style></head>
<body><header><div class="top"><a href="../index.html">← 返回错题库</a><span>基金从业 · 错题复习资料</span></div></header><main><nav class="toc" aria-label="页面目录"><strong>目录</strong>{toc}</nav><article>{body}</article></main></body></html>'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', type=Path, default=DEFAULT_SOURCE)
    args = parser.parse_args()
    output = ROOT / 'review'
    output.mkdir(exist_ok=True)
    for subject, number in [('一', '1'), ('三', '3')]:
        source = args.source_dir / f'基金从业-科目{subject}错题记忆梳理.md'
        destination = output / f'fund-subject-{number}.html'
        destination.write_text(page(source.read_text(encoding='utf-8')), encoding='utf-8')
        print(f'{source} -> {destination}')


if __name__ == '__main__':
    main()
