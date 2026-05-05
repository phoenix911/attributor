.PHONY: setup deploy dev tail db-init db-cleanup secrets dashboard-open commit help
.DEFAULT_GOAL := help

BOLD  := \033[1m
RESET := \033[0m
CYAN  := \033[36m
GREEN := \033[32m
DIM   := \033[2m

ifneq (,$(wildcard .env))
  include .env
  export
endif

##@ Setup & deploy
setup: ## Interactive wizard — auth, D1 create, schema apply, secret, deploy
	@bash scripts/setup.sh

deploy: ## Deploy worker (uses code/wrangler.toml)
	cd code && npx wrangler deploy

dev: ## Local dev server at localhost:8787
	cd code && npx wrangler dev

tail: ## Stream live logs from the deployed worker
	cd code && npx wrangler tail

##@ Database
db-init: ## Apply schema.sql to remote D1
	cd code && npx wrangler d1 execute attribution --remote --file=./schema.sql

db-cleanup: ## Run cleanup.sql against remote D1 (manual retention sweep)
	cd code && npx wrangler d1 execute attribution --remote --file=./cleanup.sql

##@ Cloudflare UI
secrets: ## Open Cloudflare dashboard → Variables & Secrets for this worker
	@open "https://dash.cloudflare.com/?to=/:account/workers/services/view/attributor/production/settings" || \
	 echo "Open: https://dash.cloudflare.com → Workers & Pages → attributor → Settings → Variables & Secrets"

dashboard-open: ## Open the worker overview in the Cloudflare dashboard
	@open "https://dash.cloudflare.com/?to=/:account/workers/services/view/attributor/production" || \
	 echo "Open: https://dash.cloudflare.com → Workers & Pages → attributor"

##@ Git
commit: ## Stage all, commit, push  (MSG="..."  NP=1 to skip push)
	@BRANCH=$$(git rev-parse --abbrev-ref HEAD); \
	echo "You are currently on branch: $$BRANCH"; \
	read -p "Proceed with commit? (y/n): " proceed </dev/tty; \
	if [ "$$proceed" != "y" ]; then echo "Commit aborted."; exit 1; fi; \
	if [ -n "$(MSG)" ]; then msg="$(MSG)"; else read -p "Enter commit message: " msg </dev/tty; fi; \
	git add -A; \
	git commit -m "$$msg"; \
	if [ -z "$(NP)" ]; then git push origin $$BRANCH; else echo "Committed but not pushed (NP=1)."; fi

##@
help: ## Show this help
	@awk ' \
	  /^##@ / { \
	    group = substr($$0, 5); \
	    printf "\n$(BOLD)$(CYAN)%s$(RESET)\n", group; \
	    next \
	  } \
	  /^[a-zA-Z_-]+:.*## / { \
	    split($$0, a, ":.*## "); \
	    printf "  $(GREEN)make %-18s$(RESET) $(DIM)%s$(RESET)\n", a[1], a[2] \
	  } \
	' $(MAKEFILE_LIST)
