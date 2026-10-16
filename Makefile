UUID      := moni@ingjae.github.io
SHELL_MAJ := $(shell gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -1)
TARGET    := $(if $(filter 42 43 44,$(SHELL_MAJ)),legacy,esm)
DEST      := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: build install uninstall test nested logs clean

build:
	python3 tools/build.py

install: build
	rm -rf $(DEST) && mkdir -p $(dir $(DEST)) && cp -r build/$(TARGET) $(DEST)
	@echo "Installed $(TARGET) build for GNOME $(SHELL_MAJ)."
	@echo "Restart GNOME Shell (X11: Alt+F2, r · Wayland: log out/in), then:"
	@echo "  gnome-extensions enable $(UUID)"

uninstall:
	-gnome-extensions disable $(UUID)
	rm -rf $(DEST)

# Collector smoke tests (ESM source) + legacy build sanity check.
test: build
	node tests/ui-regressions.test.cjs
	gjs -m tests/collectors.test.js
	gjs -c "imports.searchPath.unshift('build/legacy'); const C = imports.collectors; \
	  if (!C.readMemory().total || !new C.CpuSampler()) throw new Error('legacy collectors broken'); \
	  print('ok    legacy collectors load under imports.*');"
	@for f in build/legacy/*.js; do node --check $$f 2>/dev/null || { echo "FAIL  syntax $$f"; exit 1; }; done; \
	  command -v node >/dev/null && echo "ok    legacy build parses" || true

# Run a throwaway GNOME Shell in a window, with the extension loaded.
nested: install
	MUTTER_DEBUG_DUMMY_MODE_SPECS=1600x900 dbus-run-session -- gnome-shell --nested --wayland

logs:
	journalctl -f -o cat /usr/bin/gnome-shell | grep -i --line-buffered moni

clean:
	rm -rf build dist
