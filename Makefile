BIN := convoy
INSTALL_DIR := $(HOME)/.local/bin

.PHONY: build install uninstall clean test tidy

build:
	bun run build

install: build
	@mkdir -p $(INSTALL_DIR)
	@install -m 755 $(BIN) $(INSTALL_DIR)/$(BIN)
	@$(INSTALL_DIR)/$(BIN) init --global --quiet
	@echo "✓ Installed at $(INSTALL_DIR)/$(BIN)"
	@echo "  Make sure $(INSTALL_DIR) is on your PATH."

uninstall:
	@rm -f $(INSTALL_DIR)/$(BIN)
	@echo "✓ Uninstalled $(INSTALL_DIR)/$(BIN)"

clean:
	@rm -f $(BIN) src/$(BIN)

test:
	bun run typecheck
	bun test

tidy:
	bun install
