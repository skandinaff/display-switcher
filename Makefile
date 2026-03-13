SCHEMAS_DIR := schemas
BUILD_DIR := build
DIST_DIR := $(BUILD_DIR)/dist
SCRIPT_DIR := scripts
PREPARE_BUILD := $(SCRIPT_DIR)/prepare-build.sh
VERSION_FILE := VERSION
RSYNC := rsync -a --delete

RELEASE_UUID := display-switcher@skandinaff.github.com
DEV_UUID := display-switcher-dev@skandinaff.github.com
RELEASE_STAGE_DIR := $(BUILD_DIR)/$(RELEASE_UUID)
DEV_STAGE_DIR := $(BUILD_DIR)/$(DEV_UUID)
DEV_INSTALL_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(DEV_UUID)
RELEASE_VERSION := $(strip $(shell cat $(VERSION_FILE)))
VERSION ?= $(RELEASE_VERSION)

.PHONY: schemas clean dev-stage dev-install dev-pack dev-refresh pack pack-release release-stage

# Compile source schemas for quick local validation.
schemas:
	glib-compile-schemas $(SCHEMAS_DIR)

# Prepare a dev build with a dev UUID and name.
dev-stage:
	$(PREPARE_BUILD) dev $(DEV_STAGE_DIR) $(VERSION)

# Install the dev build into the local extensions directory as a real copy.
dev-install: dev-stage
	mkdir -p $(dir $(DEV_INSTALL_DIR))
	@if [ -L "$(DEV_INSTALL_DIR)" ]; then rm "$(DEV_INSTALL_DIR)"; fi
	mkdir -p $(DEV_INSTALL_DIR)
	$(RSYNC) $(DEV_STAGE_DIR)/ $(DEV_INSTALL_DIR)/

# Create a zip for the dev build.
dev-pack: dev-stage
	mkdir -p $(DIST_DIR)
	cd $(DEV_STAGE_DIR) && gnome-extensions pack --force --out-dir $(abspath $(DIST_DIR)) --extra-source=README.md --extra-source=LICENSE

# Rebuild, reinstall, disable the release UUID locally, and enable the dev UUID.
dev-refresh: dev-install
	gnome-extensions disable $(RELEASE_UUID) >/dev/null 2>&1 || true
	gnome-extensions enable $(DEV_UUID)

# Prepare a release build with the published UUID.
release-stage:
	$(PREPARE_BUILD) release $(RELEASE_STAGE_DIR) $(VERSION)

# Create the release zip to upload to extensions.gnome.org.
pack-release: release-stage
	mkdir -p $(DIST_DIR)
	cd $(RELEASE_STAGE_DIR) && gnome-extensions pack --force --out-dir $(abspath $(DIST_DIR)) --extra-source=README.md --extra-source=LICENSE

# Backward-compatible alias.
pack: pack-release

# Remove generated artifacts.
clean:
	rm -rf $(BUILD_DIR)
	rm -f $(SCHEMAS_DIR)/gschemas.compiled
