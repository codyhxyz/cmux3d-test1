// Command coding-cube is the Go terminal gateway: the Go port of `node src/server/index.js`.
//
// It serves the cube's static page, the herdr state API, and the PTY websockets. It does
// NOT mint AgentCore credentials — `--cloud` still belongs to the Node server. See
// go/README.md for what each binary owns.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/codyhxyz/coding-cube/go/internal/config"
	"github.com/codyhxyz/coding-cube/go/internal/connection"
	"github.com/codyhxyz/coding-cube/go/internal/gateway"
	"github.com/codyhxyz/coding-cube/go/internal/originauth"
	"github.com/codyhxyz/coding-cube/go/internal/tailscale"
	"github.com/codyhxyz/coding-cube/go/internal/terminal"
	"github.com/codyhxyz/coding-cube/go/internal/tokenstore"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "coding-cube failed to start: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	argv := os.Args[1:]
	// A leading `-` is a flag for the server, never a command, so the only word that
	// means anything here is `pair`. Anything else is a typo, and a typo must not start a
	// terminal server that was not asked for.
	if len(argv) > 0 && !strings.HasPrefix(argv[0], "-") && argv[0] != "serve" {
		if argv[0] == "pair" {
			return fmt.Errorf("`pair` still lives in the Node CLI: run `npm run pair`")
		}
		return fmt.Errorf("no command called %s. Try `coding-cube` or `coding-cube pair`", argv[0])
	}

	options, err := config.Read(os.Getenv, argv)
	if err != nil {
		return err
	}
	if options.CloudRequested {
		return errors.New("--cloud needs the Node server: this binary is the terminal gateway only")
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Runs before listen(), because binding the tailnet address needs no certificate and
	// is the shortest path to real shells on a phone.
	var tailnetAddr *tailscale.Address
	if (options.Expose || options.ServeOnly) && os.Getenv("CODING_CUBE_LOCAL_ONLY") != "1" {
		tailnetAddr = tailscale.Addr(ctx)
	}
	var peers originauth.Identity
	if tailnetAddr != nil && options.TrustTailnet {
		peers = tailscale.NewIdentity(options.TailscaleUsers, time.Minute)
	}

	grid, err := terminal.NewGrid(terminal.Options{
		Cwd:       options.Cwd,
		Shell:     options.Shell,
		Herdr:     options.Herdr,
		Workspace: options.Workspace,
	})
	if err != nil {
		return err
	}

	root, err := projectRoot()
	if err != nil {
		return err
	}
	exposure := &originauth.Exposure{}
	server := &gateway.Server{
		PublicRoot:  filepath.Join(root, "public"),
		VendorFiles: gateway.VendorAssets(filepath.Join(root, "node_modules")),
		WebOrigin:   options.WebOrigin,
		Token:       options.Token,
		Exposure:    exposure,
		Tailnet:     peers,
		GatewayOnly: options.GatewayOnly,
		Grid:        grid,
	}

	if err := grid.Prepare(ctx, 0); err != nil {
		// A herdr that is not up yet must not stop the gateway: the page's local shells
		// work regardless, and the next attach retries provisioning.
		log.Printf("herdr workspace not ready yet: %v", err)
	}

	// Loopback keeps working for this machine while a second address serves the tailnet,
	// so exposing the cube never takes the desktop flow away.
	hosts := []string{options.Host}
	if options.Expose && tailnetAddr != nil {
		hosts = append(hosts, tailnetAddr.IP)
	}

	listeners, port, err := listenAll(hosts, options.Port)
	if err != nil {
		return err
	}

	httpServer := &http.Server{Handler: server}
	for _, listener := range listeners {
		go func(listener net.Listener) {
			if err := httpServer.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Printf("listener stopped: %v", err)
			}
		}(listener)
	}

	fmt.Printf("coding-cube is listening at http://%s:%d/\n", options.Host, port)
	if options.Rotated {
		fmt.Println("pairing code rotated; paired phones must pair again")
	}

	if options.Expose && tailnetAddr != nil {
		phoneOrigin := fmt.Sprintf("http://%s:%d", tailnetAddr.DNSName, port)
		exposure.Active = true
		exposure.TSOrigin = phoneOrigin
		fmt.Println()
		fmt.Printf("  On your phone, open:\n  \x1b[1m%s\x1b[0m", phoneOrigin)
		if peers == nil {
			fmt.Printf("/#token=%s", options.Token)
		}
		fmt.Println()
		if peers != nil {
			fmt.Println("  (no code needed — Tailscale already knows your devices)")
		}
		fmt.Println()
	}

	fmt.Printf("  On a phone: run \x1b[1m%s\x1b[0m and scan the QR.\n", pairCommand())

	// TLS is deliberately separate from direct tailnet binding: a cloud gateway stays on
	// loopback and lets Tailscale Serve authenticate every request.
	if tailnetAddr != nil {
		go upgradeToTLS(ctx, port, options.WebOrigin, options.Token, peers != nil, exposure)
	}

	if os.Getenv("CODING_CUBE_OPEN") != "0" {
		webURL := connection.PairingURL(options.WebOrigin, fmt.Sprintf("http://127.0.0.1:%d", port), options.Token)
		if runtime.GOOS == "darwin" {
			_ = exec.Command("open", webURL).Start()
		} else {
			fmt.Printf("open %s\n", webURL)
		}
	}

	<-ctx.Done()

	grid.CloseAll()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return httpServer.Shutdown(shutdownCtx)
}

// listenAll binds every host to one port. Sequential, because port 0 lets the OS choose
// and the extra listeners have to reuse whatever the first one was given.
func listenAll(hosts []string, port int) ([]net.Listener, int, error) {
	var listeners []net.Listener
	for _, host := range hosts {
		listener, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
		if err != nil {
			for _, open := range listeners {
				open.Close()
			}
			return nil, 0, err
		}
		if port == 0 {
			port = listener.Addr().(*net.TCPAddr).Port
		}
		listeners = append(listeners, listener)
	}
	return listeners, port, nil
}

// upgradeToTLS asks Tailscale Serve for a TLS origin, or prints the one-click URL that
// turns Serve on. The hosted page is https, so it can only reach this machine over TLS.
func upgradeToTLS(ctx context.Context, port int, webOrigin, token string, trusted bool, exposure *originauth.Exposure) {
	offer := tailscale.OfferServe(ctx, port)
	if offer.TSOrigin != "" {
		exposure.Active = true
		exposure.TSOrigin = offer.TSOrigin
		fmt.Printf("tailnet TLS: %s\n", offer.TSOrigin)
		if offer.Funnel {
			fmt.Println("  warning: funnel is on for this port — it is reachable from the public internet")
		}
		shared := token
		if trusted {
			shared = ""
		}
		fmt.Printf("  %s now works on your phone too:\n  %s\n", webOrigin,
			connection.PairingURL(webOrigin, offer.TSOrigin, shared))
		return
	}
	if offer.EnableURL == "" {
		return
	}
	fmt.Println()
	fmt.Printf("  Want %s itself to work on your phone? Turn on Tailscale Serve once:\n", webOrigin)
	fmt.Printf("  %s\n", offer.EnableURL)
	fmt.Println("  Then restart with --expose. The address above works either way.")
}

// projectRoot finds the checkout whose public/ and node_modules/ this binary serves.
// CODING_CUBE_ROOT wins, then the directory above the binary (go/bin/coding-cube inside a
// checkout), then the working directory.
func projectRoot() (string, error) {
	if root := os.Getenv("CODING_CUBE_ROOT"); root != "" {
		return root, nil
	}
	if executable, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(executable); err == nil {
			executable = resolved
		}
		for dir := filepath.Dir(executable); ; {
			if _, err := os.Stat(filepath.Join(dir, "public", "index.html")); err == nil {
				return dir, nil
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return os.Getwd()
}

// pairCommand is the spelling that will actually work from here. install.sh writes a
// launcher but never puts it on PATH, and `npm run pair` only exists inside a checkout —
// printing a word the reader's shell cannot find is worse than printing a long path.
func pairCommand() string {
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		if dir == "" {
			continue
		}
		if _, err := os.Stat(filepath.Join(dir, "coding-cube")); err == nil {
			return "coding-cube pair"
		}
	}
	launcher := filepath.Join(tokenstore.StateDir(os.Getenv), "bin", "coding-cube")
	if _, err := os.Stat(launcher); err == nil {
		return launcher + " pair"
	}
	return "npm run pair"
}
