dev-start:
	docker compose -f docker-compose.prod.yml up --build

dev-start-production:
	docker compose -f docker-compose.prod.yml --profile production up --build

dev-start-no-cache:
	docker compose -f docker-compose.prod.yml up --build --no-cache

dev-build-no-cache:
	docker compose -f docker-compose.prod.yml --build --no-cache

dev-stop-clean:
	docker compose down -v