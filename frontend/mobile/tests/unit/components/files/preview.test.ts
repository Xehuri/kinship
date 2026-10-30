/// <reference types="vitest/globals" />

import { describe, expect, it } from 'vitest'
import {
  getCodeLanguage,
  getFileIconName,
  getFilePreviewKind,
} from '@/components/files/preview'

describe('getFilePreviewKind', () => {
  it.each([
    ['photo.png', 'image'],
    ['photo.JPG', 'image'],
    ['diagram.svg', 'image'],
    ['voice.wav', 'audio'],
    ['voice.m4a', 'audio'],
    ['README.md', 'md'],
    ['perception.jsonl', 'jsonl'],
    ['health.json', 'json'],
    ['fact_extractor.py', 'code'],
    ['notes.txt', 'text'],
    ['NOTES.TXT', 'text'],
    ['server.log', 'text'],
    ['archive.zip', 'unsupported'],
    ['file-without-extension', 'unsupported'],
  ] as const)('dispatches %s to %s', (name, expected) => {
    expect(getFilePreviewKind(name)).toBe(expected)
  })

  it('checks jsonl before the shorter json suffix', () => {
    expect(getFilePreviewKind('events.jsonl')).toBe('jsonl')
    expect(getFilePreviewKind('events.json')).toBe('json')
  })
})

describe('getCodeLanguage', () => {
  it('maps common extensions to language ids', () => {
    expect(getCodeLanguage('app.py')).toBe('python')
    expect(getCodeLanguage('main.ts')).toBe('typescript')
    expect(getCodeLanguage('notes.txt')).toBe('text')
  })

  it('returns an empty language for unknown extensions', () => {
    expect(getCodeLanguage('data.bin')).toBe('')
  })
})

describe('getFileIconName', () => {
  it('uses the folder icon for directories regardless of kind', () => {
    expect(getFileIconName('unsupported', true)).toBe('Folder')
  })

  it.each([
    ['image', 'Image'],
    ['audio', 'Waveform'],
    ['json', 'Database'],
    ['jsonl', 'Database'],
    ['code', 'Code'],
    ['text', 'FileText'],
    ['md', 'FileText'],
    ['unsupported', 'FileText'],
  ] as const)('maps %s to %s', (kind, expected) => {
    expect(getFileIconName(kind)).toBe(expected)
  })
})
