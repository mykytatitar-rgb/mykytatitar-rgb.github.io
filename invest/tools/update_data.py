#!/usr/bin/env python3
"""Оновлення даних «Портфеля».

Що робить:
  1. Бере звіт Flex з Interactive Brokers (позиції, угоди, рух грошей, вартість рахунку по днях).
  2. Додає ціни ринку (фонд VOO, з дивідендами) і курс долара НБУ.
  3. Зливає з попередніми даними, щоб історія не обрізалась на 365 днях.
  4. Шифрує все паролем (AES-GCM, ключ з пароля через PBKDF2-SHA256) і пише data.enc.json.
     Відкриті дані нікуди не пишуться: сторінки GitHub Pages публічні.

Запуск у GitHub Actions (.github/workflows/invest-data.yml):
    IBKR_FLEX_TOKEN=... IBKR_FLEX_QUERY_ID=... INVEST_PASSWORD=... \\
    python invest/tools/update_data.py --prev prev.enc.json --out out/data.enc.json

Перевірка на своєму комп'ютері зі збереженим звітом, без мережі:
    INVEST_PASSWORD=... python update_data.py --xml statement.xml --offline --out data.enc.json

Потрібна бібліотека cryptography: pip install cryptography
"""
import argparse
import base64
import bisect
import csv
import io
import json
import os
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime, timedelta, timezone

FLEX_SEND = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest'
FLEX_GET = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement'
BENCH = 'VOO'
KDF_ITER = 600_000
SCHEMA = 1

# Коди помилок Flex Web Service: «спробуй трохи згодом» і зрозумілі пояснення решти
FLEX_RETRY = {'1001', '1004', '1005', '1006', '1007', '1008', '1009', '1019', '1021'}
FLEX_HINTS = {
    '1012': 'Токен Flex прострочений. Створи новий в IBKR (Flex Web Service) і онови секрет IBKR_FLEX_TOKEN.',
    '1015': 'Токен Flex неправильний. Перевір секрет IBKR_FLEX_TOKEN.',
    '1014': 'Звіт Flex не знайдено. Перевір секрет IBKR_FLEX_QUERY_ID.',
    '1013': 'Токен обмежений за IP-адресою. Створи токен без обмеження IP: адреси GitHub щоразу інші.',
    '1011': 'Flex Web Service вимкнений. Увімкни його в IBKR: Performance & Reports, Flex Queries.',
    '1010': 'Це старий тип звіту. Потрібен Activity Flex Query.',
    '1016': 'Рахунок у звіті недійсний. Перевір налаштування звіту Flex.',
    '1020': 'IBKR не прийняв запит. Перевір токен і номер звіту.',
}


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def fail(msg, code=1):
    log('Помилка: ' + msg)
    sys.exit(code)


# ---------------------------------------------------------------- мережа

def http_get(url, ua='portfel-updater/1.0 (+https://github.com)', timeout=40, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': ua, 'Accept': '*/*'})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:      # у тексті помилки немає адреси, тож токен не потрапить у журнал
            last = RuntimeError('HTTP %s' % e.code)
            if e.code in (400, 401, 403, 404):
                break
        except Exception as e:                     # таймаут, обрив з'єднання
            last = RuntimeError(type(e).__name__)
        time.sleep(3 * (i + 1))
    raise last


# ---------------------------------------------------------------- Flex

class FlexError(Exception):
    def __init__(self, code, msg):
        super().__init__('%s: %s' % (code, msg))
        self.code, self.msg = code, msg


def _child_text(el, tag):
    c = el.find(tag)
    return c.text.strip() if c is not None and c.text else ''


def flex_download(token, query_id, max_wait=300):
    """Двокроковий запит Flex: SendRequest дає номер звіту, GetStatement віддає сам звіт."""
    q = urllib.parse.urlencode({'t': token, 'q': query_id, 'v': '3'})
    first = ET.fromstring(http_get(FLEX_SEND + '?' + q, ua='Java'))
    if _child_text(first, 'Status') != 'Success':
        raise FlexError(_child_text(first, 'ErrorCode') or '?', _child_text(first, 'ErrorMessage'))
    ref = _child_text(first, 'ReferenceCode')
    url = _child_text(first, 'Url') or FLEX_GET
    host = urllib.parse.urlparse(url).hostname or ''
    if not host.endswith('.interactivebrokers.com'):
        url = FLEX_GET                              # токен ходить лише до IBKR
    started, delay = time.time(), 5
    time.sleep(3)
    while True:
        body = http_get(url + '?' + urllib.parse.urlencode({'t': token, 'q': ref, 'v': '3'}), ua='Java')
        if b'<FlexQueryResponse' in body[:4000]:
            return body
        try:
            r = ET.fromstring(body)
            code, msg = _child_text(r, 'ErrorCode'), _child_text(r, 'ErrorMessage')
        except ET.ParseError:
            code, msg = '?', 'незрозуміла відповідь IBKR'
        if code not in FLEX_RETRY and code != '1018':
            raise FlexError(code, msg)
        if time.time() - started > max_wait:
            raise FlexError(code, 'IBKR так і не підготував звіт за %d с' % max_wait)
        time.sleep(15 if code == '1018' else delay)
        delay = min(delay + 5, 30)


# ---------------------------------------------------------------- розбір звіту

def num(v):
    if v is None:
        return None
    v = v.strip().replace(',', '')
    if v in ('', '--', 'N/A'):
        return None
    try:
        return float(v)
    except ValueError:
        return None


def parse_date(v):
    if not v:
        return None
    part = v.strip().split(';')[0].split(',')[0].split(' ')[0].split('T')[0]
    for fmt in ('%Y%m%d', '%Y-%m-%d', '%m/%d/%Y', '%m/%d/%y'):
        try:
            return datetime.strptime(part, fmt).date().isoformat()
        except ValueError:
            pass
    return None


def kind_of(cat, sub):
    cat, sub = (cat or '').upper(), (sub or '').upper()
    if sub == 'ETF':
        return 'etf'
    if cat == 'STK':
        return 'stock'
    if cat in ('BOND', 'BILL'):
        return 'bond'
    if cat == 'FUND':
        return 'fund'
    return 'other'


def parse_flex(xml_bytes):
    root = ET.fromstring(xml_bytes)
    if root.tag != 'FlexQueryResponse':
        raise ValueError('це не звіт Flex')
    st = root.find('.//FlexStatement')
    if st is None:
        raise ValueError('у звіті немає FlexStatement')
    out = {'from': parse_date(st.get('fromDate')), 'to': parse_date(st.get('toDate')),
           'nav': {}, 'positions': [], 'trades': [], 'cash': [], 'cash_report': None}

    # Вартість рахунку по днях (розділ Net Asset Value (NAV) in Base)
    for e in st.iter('EquitySummaryByReportDateInBase'):
        d, total = parse_date(e.get('reportDate')), num(e.get('total'))
        if d and total is not None:
            out['nav'][d] = {'total': total, 'cash': num(e.get('cash'))}

    # Залишок грошей у базовій валюті (розділ Cash Report), якщо немає щоденного NAV
    for e in st.iter('CashReportCurrency'):
        if (e.get('currency') or '').upper() == 'BASE_SUMMARY':
            out['cash_report'] = num(e.get('endingCash'))

    # Позиції (розділ Open Positions, рівень Summary)
    agg = {}
    for e in st.iter('OpenPosition'):
        if (e.get('levelOfDetail') or 'SUMMARY').upper() not in ('SUMMARY', ''):
            continue
        qty = num(e.get('position'))
        if not qty:
            continue
        fx = num(e.get('fxRateToBase')) or 1.0
        val_l = num(e.get('positionValue'))
        val = num(e.get('positionValueInBase'))
        if val is None and val_l is not None:
            val = val_l * fx
        cost_l, pnl_l = num(e.get('costBasisMoney')), num(e.get('fifoPnlUnrealized'))
        cost = cost_l * fx if cost_l is not None else None
        pnl = pnl_l * fx if pnl_l is not None else (val - cost if val is not None and cost is not None else None)
        if cost is None and val is not None and pnl is not None:
            cost = val - pnl
        sym = (e.get('symbol') or '').strip()
        key = sym + '|' + (e.get('currency') or '')
        p = agg.get(key)
        if p:                                       # той самий папір кількома рядками
            p['qty'] += qty
            for k, v in (('value', val), ('cost', cost), ('pnl', pnl)):
                if v is not None:
                    p[k] = (p[k] or 0) + v
            continue
        agg[key] = {'sym': sym, 'name': (e.get('description') or sym).strip(),
                    'kind': kind_of(e.get('assetCategory'), e.get('subCategory')),
                    'qty': qty, 'price': num(e.get('markPrice')), 'value': val, 'cost': cost, 'pnl': pnl,
                    'cur': e.get('currency') or 'USD', 'exch': e.get('listingExchange') or '',
                    'isin': e.get('isin') or '', 'fx': fx}
    for p in agg.values():
        for k in ('value', 'cost', 'pnl'):
            if p[k] is not None:
                p[k] = round(p[k], 4)
        out['positions'].append(p)

    # Угоди (розділ Trades, рівень Execution)
    for e in st.iter('Trade'):
        if (e.get('levelOfDetail') or 'EXECUTION').upper() != 'EXECUTION':
            continue
        if 'cancel' in (e.get('transactionType') or '').lower() or '(CA.)' in (e.get('buySell') or '').upper():
            continue
        qty = abs(num(e.get('quantity')) or 0)
        if not qty:
            continue
        bs = (e.get('buySell') or '').upper()
        fx = num(e.get('fxRateToBase')) or 1.0
        net = num(e.get('netCash'))
        cat = (e.get('assetCategory') or '').upper()
        out['trades'].append({
            'd': parse_date(e.get('tradeDate')) or parse_date(e.get('dateTime')),
            'sym': (e.get('symbol') or '').strip(),
            'side': 'BUY' if bs.startswith('BUY') else 'SELL' if bs.startswith('SELL') else bs,
            'qty': qty, 'price': num(e.get('tradePrice')),
            'amount': round(net * fx, 6) if net is not None else None,
            'fee': round(abs(num(e.get('ibCommission')) or 0) * fx, 6),
            'pnl': round((num(e.get('fifoPnlRealized')) or 0) * fx, 6),
            'cur': e.get('currency') or 'USD', 'kind': 'CASH' if cat == 'CASH' else (cat or 'STK'),
            'exch': e.get('listingExchange') or e.get('exchange') or '',
            'id': e.get('tradeID') or e.get('transactionID') or e.get('ibExecID') or '', 'fx': fx})

    # Рух грошей (розділ Cash Transactions)
    for e in st.iter('CashTransaction'):
        if (e.get('levelOfDetail') or 'DETAIL').upper() == 'SUMMARY':
            continue
        amt = num(e.get('amount'))
        if amt is None:
            continue
        fx = num(e.get('fxRateToBase')) or 1.0
        t = (e.get('type') or '').lower()
        if 'deposit' in t or 'withdraw' in t:
            kind = 'deposit' if amt > 0 else 'withdrawal'
        elif 'dividend' in t or 'in lieu' in t:
            kind = 'dividend'
        elif 'withholding' in t or 'tax' in t:
            kind = 'tax'
        elif 'interest' in t:
            kind = 'interest'
        elif 'fee' in t or 'commission' in t:
            kind = 'fee'
        else:
            kind = 'other'
        out['cash'].append({
            'd': parse_date(e.get('dateTime')) or parse_date(e.get('settleDate')) or parse_date(e.get('reportDate')),
            'type': kind, 'amount': round(amt * fx, 6), 'sym': (e.get('symbol') or '').strip(),
            'desc': (e.get('description') or '').strip()[:80],
            'id': e.get('transactionID') or ''})
    return out


# ---------------------------------------------------------------- ринок і курс

def fetch_yahoo(sym, rng='5y', adjusted=True):
    """Денні ціни закриття з Yahoo Finance. adjusted: з урахуванням дивідендів (для порівняння з ринком);
    інакше звичайна ціна (для вартості позиції в конкретний день)."""
    for host in ('query1', 'query2'):
        try:
            url = ('https://%s.finance.yahoo.com/v8/finance/chart/%s?range=%s&interval=1d'
                   '&includeAdjustedClose=true&events=div%%2Csplit' % (host, urllib.parse.quote(sym), rng))
            res = json.loads(http_get(url, ua='Mozilla/5.0 (X11; Linux x86_64) portfel-updater'))['chart']['result'][0]
            off = (res.get('meta') or {}).get('gmtoffset') or 0
            ind = res['indicators']
            adj = (ind.get('adjclose') or [{}])[0].get('adjclose') if adjusted else None
            vals = adj or ind['quote'][0]['close']
            rows = [[datetime.fromtimestamp(t + off, tz=timezone.utc).date().isoformat(), round(v, 4)]
                    for t, v in zip(res['timestamp'], vals) if v is not None]
            if len(rows) > 20:
                return rows, bool(adj), 'Yahoo Finance'
        except Exception as e:
            log('Ціни: Yahoo (%s, %s) не відповів: %s' % (host, sym, e))
    return None


# Біржа IBKR → суфікс тікера в Yahoo (американські біржі без суфікса)
YAHOO_SUFFIX = {'LSE': '.L', 'LSEETF': '.L', 'IBIS': '.DE', 'IBIS2': '.DE', 'XETRA': '.DE', 'GETTEX': '.DE',
                'FWB': '.F', 'AEB': '.AS', 'SBF': '.PA', 'BVME': '.MI', 'BVME.ETF': '.MI', 'EBS': '.SW',
                'SWX': '.SW', 'BM': '.MC', 'WSE': '.WA', 'TSE': '.TO', 'VENTURE': '.V', 'ASX': '.AX', 'SEHK': '.HK'}


def yahoo_ticker(sym, exch):
    return sym.strip().replace(' ', '-').replace('.', '-') + YAHOO_SUFFIX.get((exch or '').upper(), '')


def fetch_stooq(sym):
    try:
        text = http_get('https://stooq.com/q/d/l/?s=%s.us&i=d' % sym.lower()).decode('utf-8', 'replace')
        rows = []
        for r in csv.DictReader(io.StringIO(text)):
            c = num(r.get('Close'))
            if r.get('Date') and c is not None:
                rows.append([r['Date'], round(c, 4)])
        if len(rows) > 20:
            return rows, False, 'Stooq'
    except Exception as e:
        log('Ринок: Stooq не відповів: %s' % e)
    return None


def merge_bench(new_rows, prev_rows):
    """Нові ціни головні. Старіші дати з попередніх даних підтягуємо до масштабу нових
    (скориговані на дивіденди ціни щоразу трохи зсуваються)."""
    if not prev_rows:
        return new_rows
    first = new_rows[0][0]
    older = [r for r in prev_rows if r[0] < first]
    if not older:
        return new_rows
    prev_map = dict(map(tuple, prev_rows))
    ratio = new_rows[0][1] / prev_map[first] if prev_map.get(first) else 1.0
    return [[d, round(v * ratio, 4)] for d, v in older] + new_rows


def fetch_nbu():
    data = json.loads(http_get('https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&json'))
    r = data[0]
    return {'rate': float(r['rate']), 'date': datetime.strptime(r['exchangedate'], '%d.%m.%Y').date().isoformat()}


# ---------------------------------------------------------------- збирання даних

def _dedupe(items, prev_items, window_start, key):
    """Записи зі звіту головні; з попередніх даних беремо лише те, що старіше за вікно звіту."""
    seen, out = set(), []
    for x in items:
        k = key(x)
        if x.get('d') and k not in seen:
            seen.add(k)
            out.append(x)
    for x in prev_items or []:
        if x.get('d') and (not window_start or x['d'] < window_start) and key(x) not in seen:
            seen.add(key(x))
            out.append(x)
    return sorted(out, key=lambda x: x['d'], reverse=True)


# ---------------------------------------------------------------- вартість активів на кожне закриття

def snapshot_plan(stmt, prev):
    """Дні зі звіту, для яких ще немає запису вартості активів, і папери, чиї ціни для них потрібні."""
    have = {s[0] for s in (prev or {}).get('snaps', [])}
    nav_dates = sorted(stmt['nav'])
    as_of = nav_dates[-1] if nav_dates else stmt['to']
    missing = [d for d in nav_dates if d not in have and d != as_of]
    need = {}
    if missing:
        for p in stmt['positions']:
            need[p['sym']] = p['exch']
        for t in stmt['trades']:
            if t['kind'] != 'CASH' and t['d'] and t['d'] > missing[0] and t['sym'] not in need:
                need[t['sym']] = t['exch']
    return missing, need


def _closer(rows):
    """Ціна закриття на дату або на останній торговий день перед нею (не давніше тижня)."""
    days = [r[0] for r in rows]
    vals = [r[1] for r in rows]

    def at(d):
        i = bisect.bisect_right(days, d) - 1
        if i < 0 or (datetime.fromisoformat(d) - datetime.fromisoformat(days[i])).days > 7:
            return None
        return vals[i]
    return at


def rebuild_snaps(stmt, missing, prices):
    """Відновлює вартість активів на минулі закриття, яких ще немає в записах: кількість паперів
    рахуємо назад від сьогоднішньої за угодами, ціни беремо з Yahoo і прив'язуємо до ціни IBKR
    (так збігаються валюта й масштаб). День, для якого бракує хоч однієї ціни, пропускаємо."""
    out = {}
    if not missing:
        return out
    pos = {p['sym']: p for p in stmt['positions']}
    trades = [t for t in stmt['trades'] if t['kind'] != 'CASH' and t['d']]
    syms = set(pos) | {t['sym'] for t in trades}
    ref_day = max(stmt['nav']) if stmt['nav'] else stmt['to']
    at, scale = {}, {}
    for s in syms:
        rows = prices.get(s)
        if not rows:
            continue
        f = _closer(rows)
        if s in pos and pos[s].get('price'):
            ref_px, base, fx = pos[s]['price'], f(ref_day), pos[s].get('fx') or 1.0
        else:
            last = max((t for t in trades if t['sym'] == s), key=lambda t: t['d'], default=None)
            if not last or not last.get('price'):
                continue
            ref_px, base, fx = last['price'], f(last['d']), last.get('fx') or 1.0
        if base:
            at[s], scale[s] = f, ref_px / base * fx
    for d in missing:
        row, complete = {}, True
        for s in syms:
            q = pos[s]['qty'] if s in pos else 0.0
            for t in trades:
                if t['sym'] == s and t['d'] > d:
                    q += -t['qty'] if t['side'] == 'BUY' else t['qty']
            if q <= 1e-9:
                continue
            px = at[s](d) if s in at else None
            if px is None:
                complete = False
                break
            row[s] = [round(q, 6), round(q * px * scale[s], 4)]
        if not complete:
            continue
        n = stmt['nav'][d]
        cash = n['cash'] if n.get('cash') is not None else n['total'] - sum(v[1] for v in row.values())
        out[d] = [round(cash, 4), row, 0]
    return out


def build(stmt, prev, bench, uah, now, prices=None):
    prev = prev or {}
    start = stmt['from']

    # Поповнення й виведення по днях; вихідний день переносимо на найближчий торговий
    flows = defaultdict(float)
    for c in stmt['cash']:
        if c['type'] in ('deposit', 'withdrawal') and c['d']:
            flows[c['d']] += c['amount']
    nav_dates = sorted(stmt['nav'])
    for d in sorted(flows):
        if d not in stmt['nav']:
            nxt = next((x for x in nav_dates if x > d), None)
            if nxt:
                flows[nxt] += flows.pop(d)

    # Історія: попередні дні лишаються, дні зі звіту його значеннями замінюються
    hist = {r[0]: [r[1], r[2]] for r in prev.get('history', [])}
    for d, row in stmt['nav'].items():
        hist[d] = [round(row['total'], 4), round(flows.get(d, 0.0), 4)]

    positions = sorted(stmt['positions'], key=lambda p: -(p['value'] or 0))
    invested = sum(p['value'] or 0 for p in positions)
    if nav_dates:
        last = stmt['nav'][nav_dates[-1]]
        as_of, nav = nav_dates[-1], last['total']
        cash = last['cash'] if last['cash'] is not None else stmt['cash_report']
    else:                                           # без щоденного NAV: рахуємо сьогоднішню точку самі
        as_of = stmt['to'] or now.date().isoformat()
        cash = stmt['cash_report'] or 0.0
        nav = invested + cash
        hist[as_of] = [round(nav, 4), round(flows.get(as_of, 0.0), 4)]

    trade_key = lambda t: t.get('id') or '%s|%s|%s|%s|%s' % (t['d'], t['sym'], t['side'], t['qty'], t['price'])
    cash_key = lambda c: c.get('id') or '%s|%s|%s|%s' % (c['d'], c['type'], c['amount'], c.get('sym'))
    trades = _dedupe(stmt['trades'], prev.get('trades'), start, trade_key)
    cash_tx = _dedupe(stmt['cash'], prev.get('cashTx'), start, cash_key)

    order = list(prev.get('colorOrder') or [])
    for p in positions:
        if p['sym'] not in order:
            order.append(p['sym'])

    history = [[d, v[0], v[1]] for d, v in sorted(hist.items())]
    first_day = history[0][0] if history else as_of
    cutoff = (datetime.fromisoformat(first_day) - timedelta(days=14)).date().isoformat()
    bench_obj = None
    if bench:
        rows, adj, src = bench
        rows = merge_bench(rows, (prev.get('bench') or {}).get('s'))
        rows = [r for r in rows if r[0] >= cutoff]
        bench_obj = {'sym': BENCH, 'adj': adj, 'src': src, 's': rows}
    elif prev.get('bench'):
        bench_obj = prev['bench']

    # Вартість кожного активу на закритті: [дата, гроші, {тікер: [кількість, вартість]}, 1 = зі звіту / 0 = відновлено]
    snaps = {s[0]: [s[1], s[2], s[3] if len(s) > 3 else 1] for s in prev.get('snaps', [])}
    missing, _ = snapshot_plan(stmt, prev)
    for d, s in rebuild_snaps(stmt, missing, prices or {}).items():
        if d not in snaps or snaps[d][2] == 0:
            snaps[d] = s
    row = {p['sym']: [p['qty'], round(p['value'], 4)] for p in positions if p['value'] is not None}
    snap_cash = cash if cash is not None else nav - sum(v[1] for v in row.values())
    snaps[as_of] = [round(snap_cash, 4), row, 1]
    for p in positions:
        if p['sym'] not in order:
            order.append(p['sym'])
    for s in snaps.values():                       # продані папери теж мають свій колір
        for sym in s[1]:
            if sym not in order:
                order.append(sym)

    return {
        'v': SCHEMA, 'source': 'ibkr-flex', 'generated': now.strftime('%Y-%m-%dT%H:%M:%SZ'),
        'asOf': as_of, 'base': 'USD', 'nav': round(nav, 4),
        'cash': round(cash, 4) if cash is not None else None,
        'positions': positions, 'history': history, 'bench': bench_obj,
        'snaps': [[d] + v for d, v in sorted(snaps.items())],
        'trades': trades, 'cashTx': cash_tx, 'uah': uah or prev.get('uah'), 'colorOrder': order,
    }


# ---------------------------------------------------------------- шифрування

def _b64(b):
    return base64.b64encode(b).decode('ascii')


def _key(password, salt, iterations):
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    pw = unicodedata.normalize('NFC', password).encode('utf-8')
    return PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations).derive(pw)


def encrypt(obj, password, salt=None):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    salt = salt or os.urandom(16)
    iv = os.urandom(12)
    plain = json.dumps(obj, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    ct = AESGCM(_key(password, salt, KDF_ITER)).encrypt(iv, plain, None)
    return {'format': 'portfel-enc', 'v': 1,
            'kdf': {'name': 'PBKDF2', 'hash': 'SHA-256', 'iter': KDF_ITER, 'salt': _b64(salt)},
            'cipher': {'name': 'AES-GCM', 'iv': _b64(iv)}, 'data': _b64(ct)}


def decrypt(env, password):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    if env.get('format') != 'portfel-enc':
        raise ValueError('не той формат')
    salt = base64.b64decode(env['kdf']['salt'])
    key = _key(password, salt, int(env['kdf']['iter']))
    plain = AESGCM(key).decrypt(base64.b64decode(env['cipher']['iv']), base64.b64decode(env['data']), None)
    return json.loads(plain), salt


# ---------------------------------------------------------------- запуск

def main():
    ap = argparse.ArgumentParser(description='Оновлення зашифрованих даних «Портфеля»')
    ap.add_argument('--out', required=True, help='куди записати data.enc.json')
    ap.add_argument('--prev', help='попередній data.enc.json (для історії довшої за рік)')
    ap.add_argument('--xml', help='готовий звіт Flex з файлу замість завантаження з IBKR')
    ap.add_argument('--offline', action='store_true', help='не брати ціни ринку й курс з мережі')
    ap.add_argument('--plain-out', help='для перевірки: записати ще й відкритий JSON (не в GitHub Actions)')
    args = ap.parse_args()

    token, query = os.environ.get('IBKR_FLEX_TOKEN', '').strip(), os.environ.get('IBKR_FLEX_QUERY_ID', '').strip()
    if not args.xml and not token and not query:
        # Ще не налаштовано: спокійно пропускаємо, щоб щоденний запуск не слав листів про помилку
        log('Секрети IBKR ще не задано, оновлення пропущено. Як налаштувати: invest/README.md.')
        return
    password = os.environ.get('INVEST_PASSWORD', '')
    if len(password) < 8:
        fail('Секрет INVEST_PASSWORD не задано або він коротший за 8 символів.')

    prev, salt = None, None
    if args.prev and os.path.exists(args.prev) and os.path.getsize(args.prev) > 0:
        try:
            with open(args.prev, encoding='utf-8') as f:
                prev, salt = decrypt(json.load(f), password)
            log('Попередні дані: розшифровано, %d днів історії.' % len(prev.get('history', [])))
        except Exception:
            log('Попередні дані не розшифрувались (мабуть, змінився пароль). Історію почну заново зі звіту IBKR.')
            prev, salt = None, None

    if args.xml:
        with open(args.xml, 'rb') as f:
            xml = f.read()
    else:
        if not token or not query:
            fail('Задано лише один із секретів IBKR_FLEX_TOKEN та IBKR_FLEX_QUERY_ID, потрібні обидва.')
        try:
            xml = flex_download(token, query)
        except FlexError as e:
            if e.code == '1003':                   # звіт за останній день ще не готовий: наступний запуск візьме
                log('IBKR ще не підготував звіт (%s). Спробую під час наступного запуску.' % e.msg)
                return
            fail('IBKR Flex відповів помилкою %s. %s' % (e.code, FLEX_HINTS.get(e.code, e.msg)))
        except Exception as e:
            fail('Не вдалося зв\'язатися з IBKR: %s. Спробую наступного разу.' % e)

    try:
        stmt = parse_flex(xml)
    except Exception as e:
        fail('Звіт Flex не розібрано: %s. Формат має бути XML.' % e)
    if not stmt['nav'] and not stmt['positions']:
        fail('У звіті немає ні вартості рахунку, ні позицій. Додай розділи Net Asset Value (NAV) in Base і Open Positions.')

    bench, uah, prices = None, None, {}
    if not args.offline:
        bench = fetch_yahoo(BENCH) or fetch_stooq(BENCH)
        if not bench:
            log('Ринок: нових цін немає, лишаю попередні.')
        try:
            uah = fetch_nbu()
        except Exception as e:
            log('Курс НБУ не отримано (%s), лишаю попередній.' % e)
        missing, need = snapshot_plan(stmt, prev)
        if missing:
            log('Вартість активів: відновлюю %d закриттів без запису.' % len(missing))
            for sym, exch in need.items():
                got = fetch_yahoo(yahoo_ticker(sym, exch), rng='2y', adjusted=False)
                if got:
                    prices[sym] = got[0]

    data = build(stmt, prev, bench, uah, datetime.now(timezone.utc), prices)
    env = encrypt(data, password, salt)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(env, f, separators=(',', ':'))
    if args.plain_out:
        if os.environ.get('GITHUB_ACTIONS') == 'true':
            log('Відкритий JSON у GitHub Actions не пишу: він потрапив би в публічний доступ.')
        else:
            with open(args.plain_out, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=1)
    n = len(data['positions'])
    word = 'позиція' if n % 10 == 1 and n % 100 != 11 else 'позиції' if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14 else 'позицій'
    log('Готово: дані на %s, історія %d дн., %d %s, ринок: %s.' % (
        data['asOf'], len(data['history']), n, word,
        (data['bench'] or {}).get('src', 'попередні ціни') if data['bench'] else 'немає'))


if __name__ == '__main__':
    main()
