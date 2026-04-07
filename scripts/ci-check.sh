#!/bin/bash
# Headless Claude Code: run tests + type-check, report failures as JSON
claude -p "Run all tests, type-check, and report any failures with file locations" \
  --allowedTools "Bash,Read,Grep" \
  --output-format json
