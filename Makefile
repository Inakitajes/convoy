BIN := archer
INSTALL_DIR := $(HOME)/.local/bin

.PHONY: build install uninstall clean test tidy

build:
	bun run build

install: build
	@mkdir -p $(INSTALL_DIR)
	@install -m 755 $(BIN) $(INSTALL_DIR)/$(BIN)
	@bun run src/main.ts init --global
	@echo "✓ Instalado en $(INSTALL_DIR)/$(BIN)"
	@echo "  Asegúrate de que $(INSTALL_DIR) está en tu PATH."

uninstall:
	@rm -f $(INSTALL_DIR)/$(BIN)
	@echo "✓ Desinstalado $(INSTALL_DIR)/$(BIN)"

clean:
	@rm -f $(BIN) src/$(BIN)

test:
	bun run typecheck
	bun test

tidy:
	bun install
