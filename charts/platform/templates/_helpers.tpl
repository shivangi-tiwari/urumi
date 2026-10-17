{{- define "platform.fullname" -}}urumi-platform{{- end -}}

{{- define "platform.labels" -}}
app.kubernetes.io/name: platform
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "platform.selectorLabels" -}}
app: hello
{{- end -}}
