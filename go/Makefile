# The gateway ships as one static binary per target. CGO stays off so the Linux builds
# are fully static and need nothing installed on the box they land on — which is the whole
# reason this exists: node-pty is a native module, and building it on ARM Linux was the
# step this replaces.

BIN     := bin/coding-cube
DIST    := dist
PKG     := ./cmd/coding-cube
TARGETS := linux/arm64 linux/amd64 darwin/arm64 darwin/amd64

# Trim the build path and drop DWARF/symbol tables: smaller artifact, reproducible output.
LDFLAGS := -s -w
GOFLAGS := -trimpath

.PHONY: all build test race vet fmt check dist clean run

all: check build

build:
	go build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o $(BIN) $(PKG)

test:
	go test ./...

race:
	go test -race ./...

vet:
	go vet ./...

fmt:
	gofmt -l .

check: fmt vet race

# One static binary per target, named so `scp` to the right box is unambiguous.
dist:
	@mkdir -p $(DIST)
	@for target in $(TARGETS); do \
		os=$${target%/*}; arch=$${target#*/}; \
		echo "  $$os/$$arch"; \
		CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch \
			go build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o $(DIST)/coding-cube-$$os-$$arch $(PKG) || exit 1; \
	done
	@ls -lh $(DIST)

# Serve the checkout this Makefile lives in, without opening a browser.
run: build
	CODING_CUBE_OPEN=0 $(BIN)

clean:
	rm -rf bin $(DIST)
