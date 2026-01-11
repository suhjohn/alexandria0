package storage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"
	"github.com/google/uuid"
)

type R2Client struct {
	client    *s3.Client
	bucket    string
	publicURL string
}

var ErrObjectNotFound = errors.New("r2 object not found")

type DownloadMeta struct {
	ContentType   string
	ContentLength int64
}

func NewR2Client(ctx context.Context) (*R2Client, error) {
	accountID := os.Getenv("R2_ACCOUNT_ID")
	accessKeyID := os.Getenv("R2_ACCESS_KEY_ID")
	secretAccessKey := os.Getenv("R2_SECRET_ACCESS_KEY")
	bucket := os.Getenv("R2_BUCKET_NAME")
	publicURL := os.Getenv("R2_PUBLIC_URL")

	if accountID == "" || accessKeyID == "" || secretAccessKey == "" || bucket == "" {
		return nil, fmt.Errorf("R2 environment variables not set")
	}

	endpoint := fmt.Sprintf("https://%s.r2.cloudflarestorage.com", accountID)

	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(accessKeyID, secretAccessKey, "")),
		config.WithRegion("auto"),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to load AWS config: %w", err)
	}

	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(endpoint)
	})

	r2 := &R2Client{
		client:    client,
		bucket:    bucket,
		publicURL: publicURL,
	}

	if err := r2.verify(ctx); err != nil {
		return nil, err
	}

	return r2, nil
}

func (r *R2Client) verify(ctx context.Context) error {
	_, err := r.client.HeadBucket(ctx, &s3.HeadBucketInput{
		Bucket: aws.String(r.bucket),
	})
	if err != nil {
		return fmt.Errorf("failed to access R2 bucket %q: %w", r.bucket, err)
	}
	return nil
}

func (r *R2Client) UploadFromURL(ctx context.Context, sourceURL, destPath string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", sourceURL, nil)
	if err != nil {
		return "", err
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("failed to download: status %d", resp.StatusCode)
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}

	contentType := http.DetectContentType(data)

	_, err = r.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(r.bucket),
		Key:         aws.String(destPath),
		Body:        bytes.NewReader(data),
		ContentType: aws.String(contentType),
	})
	if err != nil {
		return "", fmt.Errorf("failed to upload to R2: %w", err)
	}

	publicURL := fmt.Sprintf("%s/%s", r.publicURL, destPath)
	return publicURL, nil
}

func (r *R2Client) Upload(ctx context.Context, data []byte, destPath string, contentType string) (string, error) {
	if contentType == "" {
		contentType = http.DetectContentType(data)
	}

	_, err := r.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(r.bucket),
		Key:         aws.String(destPath),
		Body:        bytes.NewReader(data),
		ContentType: aws.String(contentType),
	})
	if err != nil {
		return "", fmt.Errorf("failed to upload to R2: %w", err)
	}

	publicURL := fmt.Sprintf("%s/%s", r.publicURL, destPath)
	return publicURL, nil
}

func (r *R2Client) UploadReader(
	ctx context.Context,
	body io.Reader,
	destPath string,
	contentType string,
	contentLength int64,
) (string, error) {
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	input := &s3.PutObjectInput{
		Bucket:      aws.String(r.bucket),
		Key:         aws.String(destPath),
		Body:        body,
		ContentType: aws.String(contentType),
	}
	if contentLength > 0 {
		input.ContentLength = aws.Int64(contentLength)
	}

	_, err := r.client.PutObject(ctx, input)
	if err != nil {
		return "", fmt.Errorf("failed to upload to R2: %w", err)
	}

	publicURL := fmt.Sprintf("%s/%s", r.publicURL, destPath)
	return publicURL, nil
}

func (r *R2Client) Delete(ctx context.Context, key string) error {
	if strings.TrimSpace(key) == "" {
		return errors.New("missing key")
	}
	_, err := r.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(r.bucket),
		Key:    aws.String(key),
	})
	return err
}

func (r *R2Client) Exists(ctx context.Context, key string) (bool, error) {
	_, err := r.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(r.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		if isNotFoundErr(err) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func (r *R2Client) Download(ctx context.Context, key string) (io.ReadCloser, DownloadMeta, error) {
	out, err := r.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(r.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		if isNotFoundErr(err) {
			return nil, DownloadMeta{}, ErrObjectNotFound
		}
		return nil, DownloadMeta{}, err
	}

	meta := DownloadMeta{}
	if out.ContentType != nil {
		meta.ContentType = *out.ContentType
	}
	if out.ContentLength != nil {
		meta.ContentLength = *out.ContentLength
	}
	return out.Body, meta, nil
}

func (r *R2Client) PublicURL(key string) string {
	if r.publicURL == "" {
		return ""
	}
	return fmt.Sprintf("%s/%s", r.publicURL, key)
}

func (r *R2Client) KeyFromPublicURL(url string) (string, bool) {
	if r.publicURL == "" {
		return "", false
	}
	base := strings.TrimRight(r.publicURL, "/") + "/"
	if !strings.HasPrefix(url, base) {
		return "", false
	}
	key := strings.TrimPrefix(url, base)
	if key == "" {
		return "", false
	}
	return key, true
}

func SourceEPUBKey(bookID uuid.UUID) string {
	return path.Join("books", bookID.String(), "source.epub")
}

func CoverPath(bookID int, ext string) string {
	return path.Join("covers", fmt.Sprintf("%d%s", bookID, ext))
}

func CoverPathForEPUB(epubKey string) string {
	ext := path.Ext(epubKey)
	base := strings.TrimSuffix(epubKey, ext)
	return base + "_cover" + ext
}

func isNotFoundErr(err error) bool {
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		code := apiErr.ErrorCode()
		if code == "NotFound" || code == "NoSuchKey" {
			return true
		}
	}
	var respErr *smithyhttp.ResponseError
	if errors.As(err, &respErr) && respErr.HTTPStatusCode() == http.StatusNotFound {
		return true
	}
	return false
}
