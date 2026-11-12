#!/usr/bin/env python3
"""Collect explicitly announced exam dates from official static HTML (stdlib only).

No year-to-year date estimation. --check performs collection without writing.
Network/parse failures retain validated old sessions with status=stale.
"""
import argparse
import copy
import datetime as dt
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import tempfile
import urllib.error
import urllib.parse
import urllib.request

DOMAINS = ('cicpa.org.cn', 'mof.gov.cn', 'amac.org.cn')
PROVIDERS = {
    'cpa': ('https://cicpa.org.cn/xxfb/tzgg/', 'html', [
        'https://cicpa.org.cn/xxfb/tzgg/202512/t20251210_65740.html']),
    'intermediate': ('https://kjs.mof.gov.cn/gongzuotongzhi/', 'htm', [
        'https://kjs.mof.gov.cn/gongzuotongzhi/202511/t20251127_3977584.htm']),
    'fund': ('https://www.amac.org.cn/fwdt/wyb/rygl/cyks/cykstz/', 'html', [
        'https://www.amac.org.cn/fwdt/wyb/rygl/cyks/cykstz/202512/t20251229_27473.html',
        'https://www.amac.org.cn/fwdt/wyb/rygl/cyks/cykstz/202604/t20260427_27624.html',
        'https://www.amac.org.cn/fwdt/wyb/rygl/cyks/cykstz/202611/t20261103_28194.html']),
}


def official_url(url):
    try:
        p = urllib.parse.urlsplit(url)
        host = (p.hostname or '').lower()
        return (p.scheme == 'https' and not p.username and not p.password
                and p.port in (None, 443)
                and any(host == domain or host.endswith('.' + domain) for domain in DOMAINS))
    except (TypeError, ValueError):
        return False


def decode_html(data, content_type=''):
    """Honor explicit HTTP/meta charset; GB2312 is decoded as its superset GB18030."""
    if isinstance(data, str):
        return data
    header = content_type + ' ' + data[:4096].decode('ascii', errors='ignore')
    match = re.search(r'charset\s*=\s*[\"\']?([\w-]+)', header, re.I)
    encoding = match.group(1).lower() if match else 'utf-8'
    if encoding in ('gb2312', 'gbk', 'gb-2312'):
        encoding = 'gb18030'
    try:
        return data.decode(encoding)
    except (UnicodeDecodeError, LookupError):
        return data.decode('gb18030' if encoding == 'utf-8' else 'utf-8')


class Page(HTMLParser):
    VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}
    BLOCK = {'p', 'div', 'tr', 'td', 'th', 'li', 'br', 'h1', 'h2', 'h3'}

    def __init__(self, text):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.body_parts = []
        self.title_parts = []
        self.links = []
        self.link = None
        self.feed(text)
        self.close()
        self.body = re.sub(r'[\s\u3000]+', ' ', ''.join(self.body_parts)).strip()
        self.title = re.sub(r'\s+', ' ', ''.join(self.title_parts)).strip()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in self.BLOCK:
            self.body_parts.append(' ')
        if tag == 'a':
            self.link = [attrs.get('href', ''), []]
        if tag not in self.VOID:
            self.stack.append((tag, 'TRS_Editor' in attrs.get('class', '').split()))

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag == 'a' and self.link is not None:
            self.links.append((self.link[0], ''.join(self.link[1]).strip()))
            self.link = None
        if tag in self.BLOCK:
            self.body_parts.append(' ')
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        tags = {x[0] for x in self.stack}
        if tags & {'script', 'style'}:
            return
        if any(x[1] for x in self.stack):
            self.body_parts.append(data)
        if 'title' in tags:
            self.title_parts.append(data)
        if self.link is not None:
            self.link[1].append(data)


class _OfficialRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not official_url(newurl):
            raise ValueError('Non-official or insecure redirect rejected')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class Fetcher:
    def __init__(self, timeout=12, max_requests=60):
        self.timeout = timeout
        self.max_requests = max_requests
        self.count = 0
        self.opener = urllib.request.build_opener(_OfficialRedirect())

    def __call__(self, url):
        if not official_url(url):
            raise ValueError('Non-official URL rejected')
        for attempt in range(2):
            if self.count >= self.max_requests:
                raise RuntimeError('Request budget exhausted')
            self.count += 1
            req = urllib.request.Request(url, headers={'User-Agent': 'CPA-Study-ExamDates/1.0'})
            try:
                with self.opener.open(req, timeout=self.timeout) as response:
                    if not official_url(response.url):
                        raise ValueError('Non-official redirect rejected')
                    data = response.read(2_000_001)
                    if len(data) > 2_000_000:
                        raise ValueError('Official page exceeds size limit')
                    return decode_html(data, response.headers.get('Content-Type', ''))
            except urllib.error.HTTPError as exc:
                if attempt or (exc.code != 429 and exc.code < 500):
                    raise
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                if attempt:
                    raise


def relevant(kind, title):
    if kind == 'cpa':
        return '注册会计师' in title and ('报名时间和考试时间' in title or '考试时间' in title)
    if kind == 'intermediate':
        return '会计专业技术资格考试' in title and '考务日程' in title
    return ('年度考试计划' in title or ('基金从业' in title and '考试公告' in title))


def parse_sessions(kind, page, year, url, title=None):
    title = title or page.title
    body = page.body
    if not body:
        raise ValueError('Missing TRS_Editor article body')
    found = []
    label = {'cpa': '内地及港澳专业阶段', 'intermediate': '中级会计', 'fund': '全国统一考试'}[kind]
    if kind == 'cpa':
        region = re.search(r'内地(?:及港澳地区|及港澳)?考试[：:]?(.*?)(?:欧洲|$)', body)
        text = region.group(1) if region else ''
        pattern = rf'{year}年\s*(\d{{1,2}})月\s*(\d{{1,2}})日\s*[—–－至-]\s*(?:(\d{{1,2}})月)?\s*(\d{{1,2}})日\s*举行专业阶段考试'
        for m in re.finditer(pattern, text):
            found.append((int(m[1]), int(m[2]), int(m[3] or m[1]), int(m[4])))
    elif kind == 'intermediate':
        pattern = rf'中级会计资格考试于\s*{year}年\s*(\d{{1,2}})月\s*(\d{{1,2}})日\s*[至—–－-]\s*(?:(\d{{1,2}})月)?\s*(\d{{1,2}})日举行'
        for m in re.finditer(pattern, body):
            found.append((int(m[1]), int(m[2]), int(m[3] or m[1]), int(m[4])))
    else:
        # Annual plan: isolate national exams before industry-only and other tests.
        if '年度考试计划' in title:
            table = re.search(r'全国统一考试\s+(.*?)(?:行业专场考试|附件2|$)', body)
            if table:
                for m in re.finditer(rf'{year}年\s*(\d{{1,2}})月\s*(\d{{1,2}})日', table[1]):
                    found.append((int(m[1]), int(m[2]), int(m[1]), int(m[2])))
        elif re.search(rf'{year}年\s*\d{{1,2}}月.*基金从业.*考试公告', title):
            # The opening statement identifies the exam; never take registration dates.
            m = re.search(r'将于\s*(\d{1,2})月\s*(\d{1,2})日[^。]{0,90}举办基金从业资格全国统一考试', body)
            if m:
                found.append((int(m[1]), int(m[2]), int(m[1]), int(m[2])))
    sessions = []
    for month, day, end_month, end_day in found:
        start = dt.date(year, month, day)
        end = dt.date(year, end_month, end_day)
        if end < start:
            raise ValueError('Reversed exam date range')
        sessions.append({'id': f'{kind}-{start.isoformat()}', 'date': start.isoformat(),
                         'endDate': end.isoformat(), 'label': label,
                         'sourceUrl': url, 'sourceTitle': title})
    return sessions


def valid_old(sessions, year):
    valid = []
    for session in sessions if isinstance(sessions, list) else []:
        try:
            start = dt.date.fromisoformat(session['date'])
            end = dt.date.fromisoformat(session['endDate'])
            if (start.year == year and end.year == year and start <= end
                    and official_url(session['sourceUrl'])
                    and all(isinstance(session.get(k), str) and session[k] for k in ('id', 'label', 'sourceTitle'))):
                valid.append(copy.deepcopy(session))
        except (KeyError, TypeError, ValueError):
            continue
    return valid


def collect(year, old=None, fetcher=None, now=None, max_pages=6):
    """Fetch up to six list pages per provider and at most 12 candidate articles.

    Only list/article links in the provider's own directory tree are followed;
    no recursive links, arbitrary external links, or predicted article URLs.
    """
    fetcher = fetcher or Fetcher()
    now = now or dt.datetime.now(dt.timezone.utc).isoformat()
    result = copy.deepcopy(old) if isinstance(old, dict) else {}
    result.update(version=1, updatedAt=now)
    if not isinstance(result.get('years'), dict):
        result['years'] = {}
    for target in (year, year + 1):
        result['years'].setdefault(str(target), {})
    for kind, (base, ext, seeds) in PROVIDERS.items():
        candidates = {url: '' for url in seeds if f'/{year - 1}' in url or f'/{year}' in url or f'/{year + 1}' in url}
        listing_errors = []
        for index in range(max_pages):
            list_url = base if index == 0 else base + f'index_{index}.{ext}'
            try:
                listing_text = fetcher(list_url)
                listing = Page(listing_text)
                for href, title in listing.links:
                    url = urllib.parse.urljoin(list_url, href)
                    # Articles are one date directory beneath a verified list.
                    relative = url[len(base):] if url.startswith(base) else ''
                    if (official_url(url) and re.fullmatch(r'\d{6}/t\d{8}_\d+\.html?', relative)
                            and relevant(kind, title)
                            and any(str(y) in title for y in (year, year + 1))):
                        candidates[url] = title
                # Stop if the publisher explicitly reports no further pages.
                count = re.search(r'(?:countPage\s*=\s*|createPageHTML\(\s*)(\d+)', listing_text)
                if not listing.links and not count:
                    raise ValueError('Unrecognized official list HTML')
                if count and index + 1 >= int(count[1]):
                    break
            except Exception as exc:
                listing_errors.append(f'List retrieval failed: {type(exc).__name__}')
                break
        dates = {year: {}, year + 1: {}}
        errors = {year: list(listing_errors), year + 1: list(listing_errors)}
        for url, listed_title in list(candidates.items())[:12]:
            try:
                page = Page(fetcher(url))
                title = listed_title or page.title
                for target in (year, year + 1):
                    if str(target) not in title:
                        continue
                    sessions = parse_sessions(kind, page, target, url, title)
                    if not sessions:
                        errors[target].append('Relevant announcement has no supported explicit exam date')
                    for session in sessions:
                        session['verifiedAt'] = now
                        # Later monthly fund announcements override annual-plan provenance.
                        dates[target][session['date']] = session
            except Exception as exc:
                title_years = [y for y in (year, year + 1) if str(y) in listed_title]
                if not title_years:
                    # Known seeds declare their exam year independently of publication date.
                    title_years = [2026] if url in seeds else [year, year + 1]
                for target in title_years:
                    if target in errors:
                        errors[target].append(f'Announcement retrieval/parse failed: {type(exc).__name__}')
        for target in (year, year + 1):
            previous = result['years'][str(target)].get(kind, {})
            previous = previous if isinstance(previous, dict) else {}
            sessions = sorted(dates[target].values(), key=lambda s: s['date'])
            parsed_this_run = bool(sessions)
            old_sessions = valid_old(previous.get('sessions', []), target)
            for session in old_sessions:
                if 'verifiedAt' not in session and previous.get('checkedAt'):
                    session['verifiedAt'] = previous['checkedAt']
            if errors[target]:
                merged = {s['date']: s for s in old_sessions}
                merged.update({s['date']: s for s in sessions})
                sessions = sorted(merged.values(), key=lambda s: s['date'])
                status = 'stale'
            elif sessions:
                status = 'published'
            elif old_sessions:
                sessions, status = old_sessions, 'stale'
                errors[target].append('Previously published dates absent from current discovery window')
            else:
                status = 'unpublished'
            entry = {'status': status, 'attemptedAt': now,
                     'checkedAt': now if parsed_this_run else previous.get('checkedAt'),
                     'sessions': sessions}
            if errors[target]:
                entry['error'] = '; '.join(dict.fromkeys(errors[target]))
            result['years'][str(target)][kind] = entry
    return result


def atomic_write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    name = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                         prefix=path.name + '.', suffix='.tmp', delete=False) as stream:
            name = stream.name
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if name and os.path.exists(name):
            os.unlink(name)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'web/data/exam-dates.json')
    parser.add_argument('--year', type=int, default=dt.datetime.now(dt.timezone(dt.timedelta(hours=8))).year)
    parser.add_argument('--check', action='store_true', help='Collect and print status without writing any file')
    args = parser.parse_args(argv)
    if not 2000 <= args.year <= 2100:
        parser.error('--year must be between 2000 and 2100')
    old = None
    if args.output.exists():
        with args.output.open(encoding='utf-8') as stream:
            old = json.load(stream)
    result = collect(args.year, old)
    if not args.check:
        atomic_write(args.output, result)
    summary = {year: {kind: entry['status'] for kind, entry in entries.items()}
               for year, entries in result['years'].items() if year in (str(args.year), str(args.year + 1))}
    print(json.dumps(summary, ensure_ascii=False))
    return 1 if any(status == 'stale' for entries in summary.values() for status in entries.values()) else 0


if __name__ == '__main__':
    raise SystemExit(main())
