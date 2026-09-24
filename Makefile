# Thin wrapper around npm scripts — kept only for muscle-memory consistency
# with the other pf-* repos (which are Python/uv-based and use
# `make install/check/test/lint`). All real logic lives in package.json and
# scripts/; this file must never grow logic of its own.

.PHONY: install lint test check push

install:
	npm install
	git config core.hooksPath .githooks

lint:
	npm run lint

test:
	npm run test:coverage

check: lint test

push:
	@test -n "$(ALIAS)" || (echo "ERROR: ALIAS is required, e.g. make push ALIAS=exchange-rates" && exit 1)
	bash scripts/push-target.sh $(ALIAS)
