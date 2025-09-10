SCHEMAS_DIR := schemas

.PHONY: schemas clean pack

# Compile local GSettings schemas used by the extension
schemas:
	glib-compile-schemas $(SCHEMAS_DIR)

# Remove compiled schema
clean:
	rm -f $(SCHEMAS_DIR)/gschemas.compiled

# Optionally create an installable ZIP (requires gnome-extensions CLI)
pack: schemas
	gnome-extensions pack --force --extra-source=README.md --extra-source=stylesheet.css

