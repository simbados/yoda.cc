// gos — minimal static file server.
// Serves the given directory (default: current directory) over HTTP.
// Registers .js as "application/javascript" so browsers accept ES module
// scripts on hosts whose MIME database omits that mapping.
//
// Usage:
//
//	gos
//	gos -dir ./web
//	gos -dir ./web -port 9000
package main

import (
	"flag"
	"fmt"
	"log"
	"mime"
	"net/http"
	"os"
)

// newHandler returns an http.Handler that serves static files from dir.
func newHandler(dir string) http.Handler {
	mime.AddExtensionType(".js", "application/javascript")
	return http.FileServer(http.Dir(dir))
}

// main parses the -port and -dir flags, starts the file server, and prints the URL.
func main() {
	port := flag.String("port", "8080", "TCP port to listen on")
	dir  := flag.String("dir", ".", "Directory to serve")
	flag.Parse()

	handler := newHandler(*dir)

	addr := ":" + *port
	fmt.Fprintf(os.Stdout, "Serving %s at http://localhost%s\n", *dir, addr)
	log.Fatal(http.ListenAndServe(addr, handler))
}
