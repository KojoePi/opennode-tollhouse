# Relayted Tollhouse
COMPOSE := docker compose
.PHONY: install update logs status restart stop test uninstall
install:
	@./install.sh
update:
	$(COMPOSE) up -d --build
	# The worker firewall pins web's IP at start: restart it whenever web was recreated.
	$(COMPOSE) restart worker
	@$(COMPOSE) ps
logs:
	$(COMPOSE) logs -f --tail=100
status:
	@$(COMPOSE) ps
	@$(COMPOSE) exec -T web node -e "fetch('http://127.0.0.1:3000/ready').then(r=>r.json()).then(j=>console.log('db ok, worker online:', j.worker))"
restart:
	$(COMPOSE) restart
stop:
	$(COMPOSE) stop
test:
	node --test --no-warnings tests/*.test.js
# Firewall self-check: all of these must fail to connect
doctor:
	@for target in http://169.254.169.254 http://10.0.0.1 http://192.168.0.1 http://172.17.0.1; do \
	  if $(COMPOSE) exec -T worker curl -s -m 3 -o /dev/null $$target; then echo "  $$target REACHABLE  <-- PROBLEM"; else echo "  $$target blocked"; fi; \
	done
uninstall:
	$(COMPOSE) down $(if $(PURGE),-v,)
