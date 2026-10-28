"""Extract authored lesson records as data. Never execute imported HTML/JavaScript."""
from __future__ import annotations

import ast
import json
import re
from html import unescape
from html.parser import HTMLParser

try:
    from .concept_canvas_inventory import extract_embedded_canvases
except ImportError:
    from concept_canvas_inventory import extract_embedded_canvases


class Scripts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.scripts = []
        self.current = None

    def handle_starttag(self, tag, attrs):
        if tag == 'script':
            self.current = {'attrs': dict(attrs), 'text': ''}
            self.scripts.append(self.current)

    def handle_data(self, text):
        if self.current is not None:
            self.current['text'] += text

    def handle_endtag(self, tag):
        if tag == 'script':
            self.current = None


class LiteralReader:
    """Small, rejecting reader for JSON-like JS literals, including quoted strings.

    It accepts no calls, property access, operators, templates or computed keys.
    This supports the authored single-quoted mind-map data without eval.
    """
    def __init__(self, text):
        self.text, self.pos = text, 0

    def space(self):
        while self.pos < len(self.text):
            match = re.match(r'\s+|//[^\n]*(?:\n|$)|/\*.*?\*/', self.text[self.pos:], re.S)
            if not match:
                return
            self.pos += match.end()

    def string(self):
        match = re.match(r'''"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*' ''', self.text[self.pos:], re.S | re.X)
        if not match:
            raise ValueError('Invalid literal string')
        self.pos += match.end()
        return ast.literal_eval(match[0])

    def value(self, depth=0):
        if depth > 40:
            raise ValueError('Nested literal limit')
        self.space()
        if self.pos >= len(self.text):
            raise ValueError('Incomplete literal')
        char = self.text[self.pos]
        if char in "\"'":
            return self.string()
        if char in '[{':
            self.pos += 1
            closing = ']' if char == '[' else '}'
            result = [] if char == '[' else {}
            self.space()
            while self.pos < len(self.text) and self.text[self.pos] != closing:
                if char == '{':
                    if self.text[self.pos] in "\"'":
                        key = self.string()
                    else:
                        match = re.match(r'[A-Za-z_$][\w$]*', self.text[self.pos:])
                        if not match:
                            raise ValueError('Invalid literal key')
                        key = match[0]
                        self.pos += match.end()
                    self.space()
                    if self.text[self.pos:self.pos+1] != ':':
                        raise ValueError('Literal key needs colon')
                    self.pos += 1
                    if key in result:
                        raise ValueError('Duplicate literal key')
                    result[key] = self.value(depth+1)
                else:
                    result.append(self.value(depth+1))
                self.space()
                if self.text[self.pos:self.pos+1] == ',':
                    self.pos += 1
                    self.space()
                elif self.text[self.pos:self.pos+1] != closing:
                    raise ValueError('Non-literal expression')
            if self.text[self.pos:self.pos+1] != closing:
                raise ValueError('Unclosed literal')
            self.pos += 1
            return result
        match = re.match(r'(?:true|false|null)\b|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?', self.text[self.pos:])
        if not match:
            raise ValueError('Executable expression is not lesson data')
        self.pos += match.end()
        return json.loads(match[0])


def declared_literal(script, name):
    match = re.search(r'\bconst\s+'+re.escape(name)+r'\s*=\s*', script)
    if not match:
        return None
    reader = LiteralReader(script[match.end():])
    value = reader.value()
    reader.space()
    if reader.text[reader.pos:reader.pos+1] not in (';', ','):
        raise ValueError('Lesson declaration must end with a literal')
    return value


def extract_lessons(text):
    parser = Scripts()
    parser.feed(text)
    records = []
    for script in parser.scripts:
        attrs, value = script['attrs'], script['text']
        tag = attrs.get('id')
        if tag in {'lesson-data', 'initial-scenario', 'additional-scenarios', 'default-scenario'}:
            data = json.loads(value)
            records += data.get('scenarios', [data]) if isinstance(data, dict) else data
        if not attrs.get('type'):
            scenario = declared_literal(value, 'SCENARIO')
            if isinstance(scenario, dict) and scenario.get('scenarioId') and scenario.get('traditions'):
                records.append({**scenario, 'id': scenario['scenarioId'],
                                'mechanism': 'cosmology-threads', 'activity_count': len(scenario['traditions'])})
            storage = re.search(r'\bconst STORAGE_KEY\s*=\s*[\"\x27]([\w.-]+)', value)
            if storage:
                stations = declared_literal(value, 'GROUPS') or declared_literal(value, 'LESSON')
                if isinstance(stations, list) and stations and all(isinstance(s, dict) and s.get('id') for s in stations):
                    title = re.search(r'<title>(.*?)</title>', text, re.S | re.I)
                    records.append({'id': re.sub(r'\.v\d+$', '', storage[1]),
                                    'title': unescape(title[1]).split(' · ')[0] if title else storage[1],
                                    'mechanism': 'image-mindmap', 'activity_count': len(stations)})
    records += extract_embedded_canvases(text)
    units = []
    for record in records:
        native = record.get('lesson_id') or record.get('id') or record.get('scenarioId')
        if not native or native == 'new_lesson' or str(record.get('title', '')).startswith('['):
            continue
        if record.get('rounds'):
            record = {**record, 'mechanism': 'concentric-rings', 'activity_count': len(record['rounds'])}
        record = {**record, 'id': native}
        if not record.get('activity_count'):
            record['activity_count'] = len(record.get('items', record.get('exercises', []))) or None
        if not any(unit['id'] == native for unit in units):
            units.append(record)
    return units
