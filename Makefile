SHELL := /bin/bash
.DEFAULT_GOAL := build

TAURI := npx --yes @tauri-apps/cli
APP_NAME := ViewPort

.PHONY: help deps dev check test build arm64 x64 universal clean

help:
	@echo "ViewPort build targets:"
	@echo "  make build      Build native production bundle (.app and .dmg)"
	@echo "  make universal  Build macOS Universal binary (Apple Silicon + Intel)"
	@echo "  make arm64      Build macOS Apple Silicon (aarch64-apple-darwin)"
	@echo "  make x64        Build macOS Intel (x86_64-apple-darwin)"
	@echo "  make dev        Run Tauri development app"
	@echo "  make check      Run cargo check and JS syntax checks"
	@echo "  make test       Run workspace unit tests"
	@echo "  make clean      Remove Cargo build artifacts"

deps:
	@if [ ! -d node_modules ]; then npm install; fi

dev: deps
	$(TAURI) dev

check:
	cargo check --workspace
	@for f in ui/script.js ui/js/*.js; do node --check "$$f"; done

test:
	cargo test --workspace

build: deps check test
	$(TAURI) build

arm64: deps
	rustup target add aarch64-apple-darwin
	$(TAURI) build --target aarch64-apple-darwin

x64: deps
	rustup target add x86_64-apple-darwin
	$(TAURI) build --target x86_64-apple-darwin

universal: deps
	rustup target add aarch64-apple-darwin x86_64-apple-darwin
	$(TAURI) build --target universal-apple-darwin

clean:
	cargo clean
