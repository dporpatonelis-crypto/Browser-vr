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


def assigned_lesson(script, name):
    """Read only a complete literal assigned to the known authored data slot."""
    match = re.search(r'\bwindow\.'+re.escape(name)+r'\s*=\s*', script)
    if not match:
        return None
    reader = LiteralReader(script[match.end():])
    value = reader.value()
    reader.space()
    if reader.text[reader.pos:reader.pos+1] != ';':
        raise ValueError('Assigned lesson must end with a literal')
    return value


def literal_declaration(script, name):
    # Runtime aliases such as `const LESSON = CONTENT.stations` are not data.
    match = re.search(r'\bconst\s+'+re.escape(name)+r'\s*=\s*', script)
    if not match or script[match.end():].lstrip()[:1] not in ('[', '{'):
        return None
    return declared_literal(script, name)


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
        if tag == 'resource-data':
            resources = json.loads(value)
            lesson = resources.get('lesson', {})
            if lesson.get('lesson_id') and lesson.get('phrases'):
                records.append({**lesson, 'mechanism': 'meaning-melody',
                                'activity_count': len(lesson['phrases'])})
        if not attrs.get('type'):
            for name in ('LESSON_CONTENT', 'LUKE_CONTENT'):
                content = assigned_lesson(value, name)
                if isinstance(content, dict) and content.get('id'):
                    mechanism = ('biography-music' if name == 'LUKE_CONTENT' else
                                 'text-music-relay' if content.get('levels') else
                                 'music-mindmap' if content.get('hymn') or content.get('hymnText') else
                                 'image-mindmap')
                    groups = content.get('stations', content.get('scenes', []))
                    if content.get('levels'):
                        groups = [scene for level in content['levels'].values() for scene in level.get('scenes', [])]
                    records.append({**content, 'mechanism': mechanism, 'activity_count': len(groups)})
            history = literal_declaration(value, 'DATA')
            if isinstance(history, dict) and history.get('cities'):
                records.append({**history, 'id': 'historical-worlds', 'mechanism': 'historical-selector',
                                'activity_count': len(history['cities'])})
            scenario = literal_declaration(value, 'SCENARIO')
            if isinstance(scenario, dict) and scenario.get('scenarioId') and scenario.get('traditions'):
                records.append({**scenario, 'id': scenario['scenarioId'],
                                'mechanism': 'cosmology-threads', 'activity_count': len(scenario['traditions'])})
            storage = re.search(r'\bconst STORAGE_KEY\s*=\s*[\"\x27]([\w.-]+)', value)
            if storage:
                stations = literal_declaration(value, 'GROUPS') or literal_declaration(value, 'LESSON')
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
        if record.get('rounds') and not record.get('mechanism'):
            record = {**record, 'mechanism': 'concentric-rings', 'activity_count': len(record['rounds'])}
        if record.get('stations') and not record.get('mechanism'):
            record = {**record, 'mechanism': 'image-mindmap', 'activity_count': len(record['stations'])}
        if record.get('scenes') and record.get('groups') and not record.get('mechanism'):
            record = {**record, 'mechanism': 'image-mindmap', 'activity_count': len(record['groups'])}
        record = {**record, 'id': native}
        if record.get('mechanism') in {'meaning-melody', 'music-mindmap', 'biography-music', 'text-music-relay'}:
            record['audio_available'] = 'data:audio/' in text
        if not record.get('activity_count'):
            record['activity_count'] = len(record.get('items', record.get('exercises', []))) or None
        if not any(unit['id'] == native for unit in units):
            units.append(record)
    return units
