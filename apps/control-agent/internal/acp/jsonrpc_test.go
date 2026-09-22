package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

const testTimeout = 5 * time.Second

type receivedNotification struct {
	method string
	params string
}

type receivedRequest struct {
	requestContext context.Context
	method         string
	params         string
}

// fakeInboundHandler records agent-initiated traffic. Requests block on the release channel while
// it is open so a test controls when an agent request is answered; cancelling the request context
// (as the connection does on failure) unblocks them regardless.
type fakeInboundHandler struct {
	notifications chan receivedNotification
	requests      chan receivedRequest
	release       chan struct{}
	responseError *ResponseError
}

func newBlockingFakeInboundHandler() *fakeInboundHandler {
	return &fakeInboundHandler{
		notifications: make(chan receivedNotification, 16),
		requests:      make(chan receivedRequest, 16),
		release:       make(chan struct{}),
	}
}

func newAnsweringFakeInboundHandler(responseError *ResponseError) *fakeInboundHandler {
	fake := newBlockingFakeInboundHandler()
	fake.responseError = responseError
	close(fake.release)
	return fake
}

func (fake *fakeInboundHandler) handleNotification(method string, params json.RawMessage) error {
	select {
	case fake.notifications <- receivedNotification{method: method, params: string(params)}:
	case <-time.After(testTimeout):
	}
	return nil
}

func (fake *fakeInboundHandler) handleRequest(requestContext context.Context, method string, params json.RawMessage) (any, *ResponseError) {
	select {
	case fake.requests <- receivedRequest{requestContext: requestContext, method: method, params: string(params)}:
	case <-time.After(testTimeout):
		return nil, nil
	}
	select {
	case <-fake.release:
	case <-requestContext.Done():
	}
	return struct{}{}, fake.responseError
}

func (fake *fakeInboundHandler) awaitNotification(t *testing.T) receivedNotification {
	t.Helper()
	select {
	case notification := <-fake.notifications:
		return notification
	case <-time.After(testTimeout):
		t.Fatal("timed out waiting for a notification")
		return receivedNotification{}
	}
}

func (fake *fakeInboundHandler) awaitRequest(t *testing.T) receivedRequest {
	t.Helper()
	select {
	case request := <-fake.requests:
		return request
	case <-time.After(testTimeout):
		t.Fatal("timed out waiting for an agent request")
		return receivedRequest{}
	}
}

// connectionHarness wires a connection to io.Pipe pairs: the test writes adapter stdout frames to
// adapterStdout and reads adapter stdin frames through readOutboundFrame.
type connectionHarness struct {
	peer          *connection
	adapterStdout *io.PipeWriter
	adapterStdin  *io.PipeReader
	outbound      *bufio.Reader
}

func startConnectionUnderTest(t *testing.T, handler *fakeInboundHandler) *connectionHarness {
	t.Helper()
	adapterStdoutReader, adapterStdoutWriter := io.Pipe()
	adapterStdinReader, adapterStdinWriter := io.Pipe()
	peer := newConnection(adapterStdoutReader, adapterStdinWriter, handler)
	peer.start()
	t.Cleanup(func() {
		adapterStdoutWriter.Close()
		adapterStdinReader.Close()
		peer.cancelBase()
		peer.closeInput()
		finished := make(chan struct{})
		go func() {
			peer.wait()
			close(finished)
		}()
		select {
		case <-finished:
		case <-time.After(testTimeout):
			t.Log("connection under test did not shut down within the timeout")
		}
	})
	return &connectionHarness{
		peer:          peer,
		adapterStdout: adapterStdoutWriter,
		adapterStdin:  adapterStdinReader,
		outbound:      bufio.NewReader(adapterStdinReader),
	}
}

func (harness *connectionHarness) sendFrame(t *testing.T, frame string) {
	t.Helper()
	written := make(chan error, 1)
	go func() {
		_, err := harness.adapterStdout.Write([]byte(frame + "\n"))
		written <- err
	}()
	select {
	case err := <-written:
		require.NoError(t, err)
	case <-time.After(testTimeout):
		t.Fatal("timed out writing a frame to the connection")
	}
}

func (harness *connectionHarness) awaitFailure(t *testing.T) error {
	select {
	case <-harness.peer.failed:
		return harness.peer.err()
	case <-time.After(testTimeout):
		t.Fatal("connection did not fail")
		return nil
	}
}

func (harness *connectionHarness) readOutboundFrame(t *testing.T) string {
	t.Helper()
	frameChannel := make(chan string, 1)
	go func() {
		frame, err := harness.outbound.ReadString('\n')
		if err != nil {
			frameChannel <- ""
			return
		}
		frameChannel <- frame
	}()
	select {
	case frame := <-frameChannel:
		require.NotEmpty(t, frame, "connection wrote no outbound frame")
		return frame
	case <-time.After(testTimeout):
		t.Fatal("timed out waiting for an outbound frame")
		return ""
	}
}

func TestConnectionRejectsProtocolViolations(t *testing.T) {
	cases := []struct {
		name  string
		frame string
	}{
		{name: "response id never issued", frame: `{"jsonrpc":"2.0","id":999,"result":{}}`},
		{name: "response with result and error", frame: `{"jsonrpc":"2.0","id":1,"result":{},"error":{"code":-1,"message":"both present"}}`},
		{name: "wrong jsonrpc version", frame: `{"jsonrpc":"1.0","id":1,"result":{}}`},
		{name: "boolean request id", frame: `{"jsonrpc":"2.0","id":true,"method":"session/poke","params":{}}`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			harness := startConnectionUnderTest(t, newAnsweringFakeInboundHandler(nil))
			harness.sendFrame(t, testCase.frame)
			failure := harness.awaitFailure(t)
			require.ErrorIs(t, failure, ErrProtocolViolation)
		})
	}
}

func TestConnectionDeliversNotificationsInOrder(t *testing.T) {
	handler := newAnsweringFakeInboundHandler(nil)
	harness := startConnectionUnderTest(t, handler)
	harness.sendFrame(t, `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1"}}`)
	harness.sendFrame(t, `{"jsonrpc":"2.0","method":"_diag/event","params":{"sequence":2}}`)
	first := handler.awaitNotification(t)
	second := handler.awaitNotification(t)
	require.Equal(t, "session/update", first.method)
	require.Equal(t, `{"sessionId":"session-1"}`, first.params)
	require.Equal(t, "_diag/event", second.method)
	require.Equal(t, `{"sequence":2}`, second.params)
}

// roundTripCall issues one call, answers the request frame it produced, and returns the request
// identifier used together with the call outcome.
func roundTripCall(t *testing.T, harness *connectionHarness, reply func(identifier int64) string, decode bool) (int64, error) {
	t.Helper()
	type callOutcome struct {
		err   error
		value int
	}
	outcome := make(chan callOutcome, 1)
	decoded := struct {
		Value int `json:"value"`
	}{}
	go func() {
		err := harness.peer.call(context.Background(), "session/new", map[string]any{"cwd": "/tmp"}, &decoded)
		outcome <- callOutcome{err: err, value: decoded.Value}
	}()
	frame := harness.readOutboundFrame(t)
	var request struct {
		ID int64 `json:"id"`
	}
	require.NoError(t, json.Unmarshal([]byte(frame), &request))
	harness.sendFrame(t, reply(request.ID))
	select {
	case result := <-outcome:
		if decode {
			require.Equal(t, 1, result.value)
		}
		return request.ID, result.err
	case <-time.After(testTimeout):
		t.Fatal("call did not complete")
		return 0, nil
	}
}

func TestConnectionCallCorrelatesResponsesAndIncrementsIDs(t *testing.T) {
	harness := startConnectionUnderTest(t, newAnsweringFakeInboundHandler(nil))
	firstIdentifier, err := roundTripCall(t, harness, func(identifier int64) string {
		return fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"result":{"value":1}}`, identifier)
	}, true)
	require.NoError(t, err)
	require.Positive(t, firstIdentifier)

	secondIdentifier, err := roundTripCall(t, harness, func(identifier int64) string {
		return fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"result":{"value":1}}`, identifier)
	}, true)
	require.NoError(t, err)
	require.Greater(t, secondIdentifier, firstIdentifier)
}

func TestConnectionCallReturnsResponseError(t *testing.T) {
	harness := startConnectionUnderTest(t, newAnsweringFakeInboundHandler(nil))
	_, err := roundTripCall(t, harness, func(identifier int64) string {
		return fmt.Sprintf(`{"jsonrpc":"2.0","id":%d,"error":{"code":%d,"message":"method not found"}}`, identifier, CodeMethodNotFound)
	}, false)
	var responseError *ResponseError
	require.ErrorAs(t, err, &responseError)
	require.Equal(t, CodeMethodNotFound, responseError.Code)
	require.Equal(t, "method not found", responseError.Message)
}

func TestConnectionEnforcesPendingRequestLimit(t *testing.T) {
	harness := startConnectionUnderTest(t, newAnsweringFakeInboundHandler(nil))

	// io.Pipe is synchronous, so the adapter stdin side must be drained for enqueues to proceed.
	requestsRead := make(chan struct{})
	go func() {
		reader := bufio.NewReader(harness.adapterStdin)
		seen := 0
		for seen < MaximumPendingRequests {
			line, err := reader.ReadString('\n')
			if err != nil {
				return
			}
			if strings.TrimSpace(line) != "" {
				seen++
			}
		}
		close(requestsRead)
	}()

	cancels := make([]context.CancelFunc, 0, MaximumPendingRequests)
	outcomes := make(chan error, MaximumPendingRequests)
	for index := 0; index < MaximumPendingRequests; index++ {
		callContext, cancel := context.WithCancel(context.Background())
		cancels = append(cancels, cancel)
		go func() {
			outcomes <- harness.peer.call(callContext, "session/prompt", nil, nil)
		}()
	}
	select {
	case <-requestsRead:
	case <-time.After(testTimeout):
		t.Fatal("pending requests were not all written")
	}

	excessContext, cancelExcess := context.WithCancel(context.Background())
	defer cancelExcess()
	err := harness.peer.call(excessContext, "session/prompt", nil, nil)
	require.ErrorIs(t, err, ErrTooManyPendingRequests)

	for _, cancel := range cancels {
		cancel()
	}
	for index := 0; index < MaximumPendingRequests; index++ {
		select {
		case callError := <-outcomes:
			require.ErrorIs(t, callError, context.Canceled)
		case <-time.After(testTimeout):
			t.Fatal("pending calls did not return after cancellation")
		}
	}
}

func TestConnectionFailsOnReaderEOF(t *testing.T) {
	harness := startConnectionUnderTest(t, newAnsweringFakeInboundHandler(nil))
	require.NoError(t, harness.adapterStdout.Close())
	failure := harness.awaitFailure(t)
	require.ErrorIs(t, failure, ErrAdapterClosed)
}

func TestConnectionAnswersAgentRequestsWithHandlerError(t *testing.T) {
	handler := newAnsweringFakeInboundHandler(&ResponseError{Code: CodeMethodNotFound, Message: "method not supported"})
	harness := startConnectionUnderTest(t, handler)
	harness.sendFrame(t, `{"jsonrpc":"2.0","id":"abc","method":"session/poke","params":{"value":7}}`)
	request := handler.awaitRequest(t)
	require.Equal(t, "session/poke", request.method)
	require.Equal(t, `{"value":7}`, request.params)

	frame := harness.readOutboundFrame(t)
	var response struct {
		ID    json.RawMessage `json:"id"`
		Error *ResponseError  `json:"error"`
	}
	require.NoError(t, json.Unmarshal([]byte(frame), &response))
	require.Equal(t, `"abc"`, string(response.ID))
	require.NotNil(t, response.Error)
	require.Equal(t, CodeMethodNotFound, response.Error.Code)
}

func TestConnectionRejectsReusedAgentRequestID(t *testing.T) {
	handler := newBlockingFakeInboundHandler()
	harness := startConnectionUnderTest(t, handler)
	harness.sendFrame(t, `{"jsonrpc":"2.0","id":"abc","method":"session/poke","params":{}}`)
	first := handler.awaitRequest(t)
	require.Equal(t, "session/poke", first.method)

	harness.sendFrame(t, `{"jsonrpc":"2.0","id":"abc","method":"session/poke","params":{}}`)
	failure := harness.awaitFailure(t)
	require.ErrorIs(t, failure, ErrProtocolViolation)
}

func TestConnectionCancelRequestCancelsHandlerContext(t *testing.T) {
	handler := newBlockingFakeInboundHandler()
	harness := startConnectionUnderTest(t, handler)
	harness.sendFrame(t, `{"jsonrpc":"2.0","id":"abc","method":"session/request_permission","params":{}}`)
	agentRequest := handler.awaitRequest(t)

	harness.sendFrame(t, `{"jsonrpc":"2.0","method":"$/cancel_request","params":{"requestId":"abc"}}`)
	select {
	case <-agentRequest.requestContext.Done():
	case <-time.After(testTimeout):
		t.Fatal("agent request context was not cancelled by $/cancel_request")
	}

	frame := harness.readOutboundFrame(t)
	var response struct {
		ID    json.RawMessage `json:"id"`
		Error *ResponseError  `json:"error"`
	}
	require.NoError(t, json.Unmarshal([]byte(frame), &response))
	require.Equal(t, `"abc"`, string(response.ID))
	require.Nil(t, response.Error)
}
