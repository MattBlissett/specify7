
FROM ubuntu:18.04

LABEL maintainer="Specify Collections Consortium <github.com/specify>"

# Get Ubuntu packages
RUN apt-get update && apt-get -y install \
	apache2 \
	build-essential \
	python3.6 \
	python3.6-dev \
        curl \
        git \
        libapache2-mod-wsgi \
        libldap2-dev \
        libmariadbclient-dev \
        libsasl2-dev \
        nodejs \
        npm \
        python3-lxml \
        python3-venv \
        unzip \
        && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 999 specify && \
    useradd -r -u 999 -g specify specify

RUN mkdir -p /home/specify && chown specify.specify /home/specify
RUN mkdir -p /opt/specify7 && chown specify.specify /opt/specify7

USER specify

COPY --chown=specify:specify . /opt/specify7
WORKDIR /opt/specify7

RUN python3.6 -m venv ve && ve/bin/pip install -r requirements.txt

RUN make specifyweb/settings/build_version.py specifyweb/settings/secret_key.py frontend

ENTRYPOINT ["bash"]
